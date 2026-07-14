import express from 'express';
import http from 'http';
import path from 'path';
import { config, validateConfig } from './config';
import { authMiddleware } from './auth';
import { importLegacyManuscripts } from './scripts/migrate';
import { startAiKeyValidation } from './aiValidate';
import { db } from './db';
import { storage } from './lib/storage/HybridManager';
import {
  reconcileReplicaTarget,
  seedPortableDatabaseManifest,
} from './lib/portableReplica';

import syncRouter from './routes/sync';
import manuscriptsRouter from './routes/manuscripts';
import aiRouter from './routes/ai';
import authRouter from './routes/auth';
import coversRouter from './routes/covers';
import pluginsRouter from './routes/plugins';
import { seedPlugins } from './lib/pluginSeed';
import { attachCollab } from './collab';
import grammarRouter from './routes/grammar';
import settingsRouter from './routes/settings';
import { mountBackup } from './routes/backup';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function start() {
  validateConfig();

  // Probe each configured AI key in the background. We log results and
  // expose them via /api/ai/config so the Settings panel can warn the
  // user about a rejected/expired key before they hit Send.
  startAiKeyValidation();

  // Run any one-shot data imports before serving requests.
  importLegacyManuscripts();

  // Keep a provider-neutral desired-state manifest even while replication is
  // disabled. Enabling S3/Nextcloud later can then seed every existing record,
  // not merely writes made after the configuration change.
  const manifestSeed = seedPortableDatabaseManifest();
  const targetSeed = reconcileReplicaTarget();
  if (manifestSeed.enqueued || targetSeed.seeded) {
    console.log(
      `[storage] manifest checked ${manifestSeed.checked} records; ` +
      `queued ${manifestSeed.enqueued + targetSeed.seeded} replica objects`,
    );
  }

  // Copy any not-yet-installed bundled plugins into DATA_DIR and compile them,
  // so a fresh or offline install is fully featured on first boot.
  await seedPlugins();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50mb' }));

  // -------- Health check (unauthenticated) --------
  // Used by Docker/k8s probes. Keep this above auth.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, time: Date.now() });
  });

  // SQLite is authoritative, so a temporarily unavailable async replica is
  // reported as degraded but does not take the writer offline.
  app.get('/readyz', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      const replica = storage.getStatus();
      // This endpoint is intentionally unauthenticated for orchestrators. Do
      // not expose provider exception text (which can contain internal hosts,
      // bucket names, or account details); the authenticated/admin CLI keeps
      // the full diagnostic.
      res.json({
        ready: true,
        database: 'ready',
        replica: {
          provider: replica.provider,
          state: replica.state,
          initialized: replica.initialized,
          pending: replica.pending,
          deadLetters: replica.deadLetters,
        },
        time: Date.now(),
      });
    } catch (error) {
      console.error('[readyz] database probe failed:', error);
      res.status(503).json({
        ready: false,
        database: 'unavailable',
        error: 'Database unavailable',
        time: Date.now(),
      });
    }
  });

  // -------- Auth bootstrap completion page --------
  // OAuth callback redirects here with the token in the fragment. This tiny
  // page stashes it in localStorage then bounces to the SPA. We render it
  // before auth so the unauthenticated NC redirect can land cleanly.
  app.get('/auth/complete', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="font-family:system-ui;padding:2rem;color:#444">
<p>Signing you in…</p>
<script>
  (function() {
    var h = (location.hash || '').replace(/^#/, '');
    var p = new URLSearchParams(h);
    var t = p.get('token');
    if (t) localStorage.setItem('chronicle_token', t);
    location.replace('/');
  })();
</script>
</body></html>`);
  });

  // -------- Auth routes (mixed: /start, /callback are unauthenticated) --------
  app.use('/api/auth', authRouter);

  // -------- API requires auth (or no-op when disabled) --------
  // Scope auth to /api ONLY. The SPA shell + its hashed assets (incl. the
  // lazily-imported checker chunks) are static code served below and must load
  // without a bearer — browsers don't attach Authorization to <script>/<link>/
  // dynamic import() fetches, so a global gate 401s them and breaks the app in
  // token/oidc mode. Data stays protected; the client authenticates its /api
  // calls and redirects to OIDC login as needed.
  app.use('/api', authMiddleware);

  app.use('/api/sync', syncRouter);
  app.use('/api/manuscripts', manuscriptsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/covers', coversRouter);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api/grammar', grammarRouter);
  app.use('/api/settings', settingsRouter);

  // Single-user local-admin surface (.chron backup/restore). No-op unless
  // LOCAL_ADMIN is set, so a shared server never exposes whole-DB export/import.
  mountBackup(app, config);

  // Unknown API paths are JSON 404s, never a misleading SPA index response.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  // -------- Static / dev server --------
  if (config.isProd) {
    const distPath = path.join(process.cwd(), 'dist', 'client');
    app.use(express.static(distPath, {
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));
    // SPA fallback. Must come last.
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    // Vite is a development dependency and should not be loaded into the
    // production server's startup path.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Last-resort route error boundary. Individual handlers can throw without
  // leaking an HTML stack trace or crashing the process.
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const typed = error as { status?: number; details?: unknown };
    const status = Number.isInteger(typed.status) ? typed.status! : 500;
    if (status >= 500) console.error('Unhandled request error:', error);
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(status).json({
      error: status >= 500 ? 'Internal server error' : errorMessage(error),
      ...(typed.details === undefined ? {} : { details: typed.details }),
    });
  });

  const httpServer = http.createServer(app);
  const collab = attachCollab(httpServer);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  // Validate connectivity in the background. Replica outages are visible via
  // /readyz and the CLI while the SQLite-first application remains usable.
  void storage.initializeReplica().catch((error) => {
    console.warn(`[storage] replica initialization failed: ${errorMessage(error)}`);
  });

  console.log(`Chronicle server listening on http://${config.host}:${config.port}`);
  console.log(`  data dir: ${config.dataDir}`);
  console.log(`  auth mode: ${config.auth.mode}`);
  console.log(`  replica: ${config.storage.replica}`);
  console.log(`  collab: ws ${config.host}:${config.port}/collab`);
  if (config.auth.mode === 'forward') {
    console.log(`  forward trusted proxies: ${config.auth.forward.trustedProxies}`);
    console.log(`  forward user header: ${config.auth.forward.headerUser}`);
  }
  if (config.auth.mode === 'oidc') {
    console.log(`  oidc issuer: ${config.auth.oidc.issuerUrl}`);
  }
  if (config.nextcloud.enabled) {
    console.log(`  nextcloud identity: ${config.nextcloud.url}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received; closing Chronicle`);

    const deadline = setTimeout(() => {
      console.error('[shutdown] graceful shutdown timed out');
      httpServer.closeAllConnections?.();
      process.exitCode = 1;
    }, 10_000);
    deadline.unref();

    const results = await Promise.allSettled([
      collab.close(),
      closeHttpServer(httpServer),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[shutdown] close failed:', result.reason);
        process.exitCode = 1;
      }
    }
    storage.close();
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (error) {
      console.error('[shutdown] database close failed:', error);
      process.exitCode = 1;
    }
    clearTimeout(deadline);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
