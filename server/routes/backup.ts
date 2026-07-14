import { Router, type Express } from 'express';
import express from 'express';
import { db } from '../db';
import { config } from '../config';
import { exportChron, stageImportChron } from '../lib/localBackup';

/**
 * Whole-database backup/restore for a single-user instance — the `.chron`
 * export/import driven by the Backup plugin.
 *
 * This is a LOCAL-ADMIN surface: it dumps and can overwrite the entire
 * database, which is only reasonable when one trusted user owns the whole
 * instance (the desktop build). It is mounted ONLY when `config.localAdmin` is
 * set (default false) via `mountBackup` below, so a shared multi-user server
 * never exposes it. The gating lives in one place so it can't drift.
 */
const router = Router();

/**
 * Availability probe. Present (200) only where the router is mounted, i.e. a
 * single-user local-admin instance; a shared server has no /api/backup/* at all
 * and this 404s. The Backup plugin calls it to decide whether to offer its UI.
 */
router.get('/status', (_req, res) => {
  res.json({ available: true });
});

/**
 * Export: stream back an xz-compressed SQLite snapshot as `<name>.chron`.
 * Compression runs only on this request — there is no background/idle work
 * (the "no compute without explicit consent" rule).
 */
router.post('/export', async (_req, res) => {
  try {
    const chron = await exportChron(db, config.dataDir);
    const name = `chronicle-${new Date().toISOString().slice(0, 10)}.chron`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(chron);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Export failed' });
  }
});

/**
 * Import: accept raw `.chron` bytes, validate + stage them, and report that a
 * restart is needed. The actual swap happens at the next boot (localBackup's
 * applyPendingImport) — never against the live handle. A safety backup of the
 * current database is written first.
 */
router.post(
  '/import',
  express.raw({ type: ['application/octet-stream', 'application/x-xz'], limit: '1024mb' }),
  async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Send the .chron file as the raw request body.' });
      return;
    }
    try {
      const { safetyBackup } = await stageImportChron(db, config.dataDir, body);
      res.json({ restartRequired: true, safetyBackup });
    } catch (err) {
      // Validation failures are the user's fault (wrong/corrupt file) → 400.
      res.status(400).json({ error: err instanceof Error ? err.message : 'Import failed' });
    }
  },
);

/**
 * Mount the backup routes iff the instance is a single-user local-admin one.
 * index.ts and the test both call this, so the guard has exactly one definition.
 */
export function mountBackup(app: Express, cfg: { localAdmin: boolean } = config): void {
  if (cfg.localAdmin) app.use('/api/backup', router);
}

export default router;
