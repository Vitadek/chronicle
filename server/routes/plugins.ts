import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { db } from '../db';
import {
  PLUGIN_ID_RE,
  PLUGINS_DIR,
  cloneRepo,
  checkForUpdates,
  pinRepo,
  pluginDir,
  pullRepo,
  removePlugin,
  writeMeta,
} from '../lib/pluginRepo';
import {
  buildPlugin,
  builtModulePath,
  describePlugin,
  readManifest,
} from '../lib/pluginBuild';

/**
 * Plugins: install from git, build, update, pin, uninstall — plus each user's
 * enable/state records.
 *
 * Replaces the old zip-upload channel, which extracted archive entries straight
 * into path.join(target, entryName) with no containment check (a `../` entry
 * escaped the plugins dir) and deleted by an unvalidated id. Git install has no
 * such surface: isomorphic-git writes only inside the repo dir, and every id
 * that touches the filesystem goes through pluginDir()'s validation.
 *
 * The built bundle is served from GET /:id/module.js — behind the API's auth
 * middleware, unlike v1's public /plugins-raw static mount.
 */
const router = Router();

// ---- helpers ---------------------------------------------------------------

interface StateRow {
  id: string;
  pluginId: string;
  manuscriptId: string | null;
  enabled: number;
  state: string;
}

const recordId = (pluginId: string, manuscriptId: string | null) =>
  `plugin_${pluginId}_${manuscriptId || 'global'}`;

function userRows(userId: string): StateRow[] {
  return db
    .prepare(
      'SELECT id, plugin_id as pluginId, manuscript_id as manuscriptId, enabled, state FROM plugin_states WHERE user_id = ?',
    )
    .all(userId) as StateRow[];
}

function upsertRecord(
  userId: string,
  pluginId: string,
  manuscriptId: string | null,
  fields: { enabled?: boolean; state?: string },
): void {
  const id = recordId(pluginId, manuscriptId);
  const existing = db
    .prepare('SELECT enabled, state FROM plugin_states WHERE user_id = ? AND id = ?')
    .get(userId, id) as { enabled: number; state: string } | undefined;

  const enabled = fields.enabled ?? !!existing?.enabled;
  const state = fields.state ?? existing?.state ?? '{}';

  db.prepare(
    `INSERT INTO plugin_states (user_id, id, plugin_id, manuscript_id, enabled, state, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       enabled = excluded.enabled,
       state = excluded.state,
       last_modified = excluded.last_modified`,
  ).run(userId, id, pluginId, manuscriptId, enabled ? 1 : 0, state, Date.now());
}

/** Every plugin directory currently on disk. */
function installedIds(): string[] {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && PLUGIN_ID_RE.test(e.name))
    .map((e) => e.name);
}

/** Disk manifest + git status, merged with this user's toggle/state. */
async function listForUser(userId: string) {
  const rows = userRows(userId);
  const out = [];
  for (const id of installedIds()) {
    const disk = await describePlugin(id);
    if (!disk) continue;
    const globalRow = rows.find((r) => r.pluginId === id && r.manuscriptId === null);
    out.push({
      ...disk,
      enabled: !!globalRow?.enabled,
      state: globalRow?.state ?? '{}',
    });
  }
  return out;
}

const idParam = (req: { params: { id: string } }): string => {
  if (!PLUGIN_ID_RE.test(req.params.id)) throw new Error('Invalid plugin id');
  return req.params.id;
};

// ---- listing ---------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    res.json({ plugins: await listForUser(req.userId!) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list plugins' });
  }
});

// ---- install ---------------------------------------------------------------

const InstallBody = z.object({
  url: z.string().url().max(500).optional(),
  /** Local folder (dev escape hatch). */
  path: z.string().max(500).optional(),
});

router.post('/install', async (req, res) => {
  const parsed = InstallBody.safeParse(req.body);
  if (!parsed.success || (!parsed.data.url && !parsed.data.path)) {
    res.status(400).json({ error: 'Provide a git "url" or a local "path".' });
    return;
  }

  // Stage into a temp dir first: we can't know the plugin's id (which decides
  // its final directory) until we've read its manifest.
  const staging = path.join(PLUGINS_DIR, `.staging-${Date.now()}`);
  try {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });

    if (parsed.data.path) {
      const src = path.resolve(parsed.data.path);
      if (!fs.existsSync(src)) throw new Error(`No such folder: ${src}`);
      // Validate BEFORE copying: otherwise pointing this at, say, /etc would
      // recursively copy the whole tree before we ever discovered it isn't a
      // plugin. Reading the manifest first makes a bad path a cheap 400.
      readManifest(src);
      fs.cpSync(src, staging, { recursive: true });
    } else {
      const gitMod = await import('isomorphic-git');
      const httpMod = await import('isomorphic-git/http/node');
      fs.mkdirSync(staging, { recursive: true });
      await gitMod.default.clone({
        fs,
        http: httpMod.default,
        dir: staging,
        url: parsed.data.url!,
        singleBranch: true,
        depth: 50,
      });
    }

    const manifest = readManifest(staging); // validates; throws with a useful message
    const finalDir = pluginDir(manifest.id); // validates the id before any FS write
    if (fs.existsSync(finalDir)) {
      throw new Error(`Plugin "${manifest.id}" is already installed.`);
    }
    fs.renameSync(staging, finalDir);
    writeMeta(finalDir, {
      gitUrl: parsed.data.url,
      pinnedRef: null,
      source: parsed.data.url ? 'git' : 'local',
    });

    const built = await buildPlugin(manifest.id);
    if (built.ok === false) {
      // Keep the install so the user can see the error and fix/update it.
      const disk = await describePlugin(manifest.id);
      res.status(422).json({ error: `Build failed: ${built.error}`, plugin: disk });
      return;
    }

    const disk = await describePlugin(manifest.id);
    res.json({ plugin: { ...disk, enabled: false, state: '{}' } });
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    res.status(400).json({ error: err instanceof Error ? err.message : 'Install failed' });
  }
});

// ---- update / pin ----------------------------------------------------------

router.post('/:id/check-updates', async (req, res) => {
  try {
    const id = idParam(req);
    res.json(await checkForUpdates(id));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Check failed' });
  }
});

router.post('/:id/update', async (req, res) => {
  try {
    const id = idParam(req);
    await pullRepo(id);
    const built = await buildPlugin(id);
    const disk = await describePlugin(id);
    if (built.ok === false) {
      res.status(422).json({ error: `Build failed: ${built.error}`, plugin: disk });
      return;
    }
    const rows = userRows(req.userId!);
    const row = rows.find((r) => r.pluginId === id && r.manuscriptId === null);
    res.json({ plugin: { ...disk, enabled: !!row?.enabled, state: row?.state ?? '{}' } });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
  }
});

const PinBody = z.object({ ref: z.string().max(120).nullable() });

router.post('/:id/pin', async (req, res) => {
  try {
    const id = idParam(req);
    const parsed = PinBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ref must be a string or null' });
      return;
    }
    await pinRepo(id, parsed.data.ref);
    if (parsed.data.ref) await buildPlugin(id); // pinned checkout = different code
    const disk = await describePlugin(id);
    const row = userRows(req.userId!).find((r) => r.pluginId === id && r.manuscriptId === null);
    res.json({ plugin: { ...disk, enabled: !!row?.enabled, state: row?.state ?? '{}' } });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Pin failed' });
  }
});

// ---- enable / state --------------------------------------------------------

const EnabledBody = z.object({ enabled: z.boolean() });

router.put('/:id/enabled', (req, res) => {
  try {
    const id = idParam(req);
    const parsed = EnabledBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    upsertRecord(req.userId!, id, null, { enabled: parsed.data.enabled });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Toggle failed' });
  }
});

const StateBody = z.object({
  state: z.string().max(256 * 1024),
  /** null = global scope; a manuscript id scopes the state to that book. */
  manuscriptId: z.string().max(64).nullable(),
});

router.put('/:id/state', (req, res) => {
  try {
    const id = idParam(req);
    const parsed = StateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid plugin state' });
      return;
    }
    // v1 hard-coded manuscriptId = null here, so per-manuscript state silently
    // collapsed into one global blob. The scope is honored now.
    upsertRecord(req.userId!, id, parsed.data.manuscriptId, { state: parsed.data.state });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Save failed' });
  }
});

// ---- module (the compiled bundle) ------------------------------------------

router.get('/:id/module.js', (req, res) => {
  try {
    const id = idParam(req);
    const file = builtModulePath(id);
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: 'Plugin is not built. Re-install or update it.' });
      return;
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    // Bundles are content-stable per commit but cheap to re-fetch; don't cache
    // aggressively or an update wouldn't take effect until a hard refresh.
    res.setHeader('Cache-Control', 'no-cache');
    res.send(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid plugin id' });
  }
});

// ---- uninstall -------------------------------------------------------------

router.delete('/:id', (req, res) => {
  try {
    const id = idParam(req); // v1 passed the raw param to path.join — traversal.
    removePlugin(id);
    db.prepare('DELETE FROM plugin_states WHERE user_id = ? AND plugin_id = ?').run(req.userId!, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Uninstall failed' });
  }
});

export default router;
