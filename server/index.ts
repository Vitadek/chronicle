import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { config, validateConfig } from './config';
import { authMiddleware } from './auth';
import { importLegacyManuscripts } from './scripts/migrate';
import { startAiKeyValidation } from './aiValidate';

import syncRouter from './routes/sync';
import manuscriptsRouter from './routes/manuscripts';
import aiRouter from './routes/ai';
import authRouter from './routes/auth';
import coversRouter from './routes/covers';
import pluginsRouter from './routes/plugins';
import pluginsExternalRouter from './routes/plugins-external';
import { attachCollab } from './collab';

async function start() {
  validateConfig();

  // Probe each configured AI key in the background. We log results and
  // expose them via /api/ai/config so the Settings panel can warn the
  // user about a rejected/expired key before they hit Send.
  startAiKeyValidation();

  // Run any one-shot data imports before serving requests.
  importLegacyManuscripts();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50mb' }));

  // -------- Health check (unauthenticated) --------
  // Used by Docker/k8s probes. Keep this above auth.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, time: Date.now() });
  });

  // -------- Harper grammar WASM (public, non-secret static asset) --------
  // The mobile editor bundle keeps Harper's 18 MB binary OUT of the APK and
  // fetches it from here on demand (chronicleEditor.setGrammarWasmUrl). Served
  // before auth so the in-WebView fetch needs no bearer.
  app.get('/assets/harper/harper_wasm_bg.wasm', (_req, res) => {
    const wasm = path.join(process.cwd(), 'node_modules/harper.js/dist/harper_wasm_bg.wasm');
    if (!fs.existsSync(wasm)) {
      res.status(404).json({ error: 'harper wasm not found' });
      return;
    }
    res.type('application/wasm');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(wasm);
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
  app.use('/api/plugins-external', pluginsExternalRouter);

  // Serve side-loaded plugin files statically (for frontend dynamic import)
  app.use('/plugins-raw', express.static(path.join(config.dataDir, 'plugins')));

  // -------- Static / dev server --------
  if (config.isProd) {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // SPA fallback. Must come last.
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const httpServer = http.createServer(app);
  attachCollab(httpServer);
  httpServer.listen(config.port, config.host, () => {
    console.log(`Chronicle server listening on http://${config.host}:${config.port}`);
    console.log(`  data dir: ${config.dataDir}`);
    console.log(`  auth mode: ${config.auth.mode}`);
    console.log(`  collab: ws ${config.host}:${config.port}/collab`);
    if (config.auth.mode === 'forward') {
      console.log(`  forward trusted proxies: ${config.auth.forward.trustedProxies}`);
      console.log(`  forward user header: ${config.auth.forward.headerUser}`);
    }
    if (config.auth.mode === 'oidc') {
      console.log(`  oidc issuer: ${config.auth.oidc.issuerUrl}`);
    }
    if (config.nextcloud.enabled) {
      console.log(`  nextcloud: ${config.nextcloud.url}` +
        (config.nextcloud.mirrorEnabled ? ' (mirror on)' : ''));
    }
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
