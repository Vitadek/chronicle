/**
 * The `.chron` backup/restore surface (server/lib/localBackup.ts + routes/backup.ts).
 *
 * Two things must hold:
 *   1. It is a LOCAL-ADMIN surface — mounted only when LOCAL_ADMIN is set, so a
 *      shared multi-user server never exposes whole-DB export/import.
 *   2. Export → stage → boot-swap actually round-trips the database, and the
 *      swap is applied at boot (not against the live handle).
 *
 * Run: npx tsx scripts/backupRoutes.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-backup-'));
process.env.DATA_DIR = dataDir;
process.env.AUTH_MODE = 'none';

const { db } = await import('../server/db');
const { saveLegacyManuscript, loadManuscript } = await import('../server/lib/manuscriptRepository');
const { exportChron, stageImportChron, applyPendingImport, primaryDbPath } = await import(
  '../server/lib/localBackup'
);
const express = (await import('express')).default;
const { mountBackup } = await import('../server/routes/backup');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Stand up a throwaway express app with the same gate index.ts uses. */
async function withApp(localAdmin: boolean, fn: (base: string) => Promise<void>) {
  const app = express();
  mountBackup(app, { localAdmin });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

try {
  // Seed a manuscript we can lose and recover.
  saveLegacyManuscript('local', {
    metadata: { id: 'book', title: 'The Original', author: 'A', lastModified: 1 },
    chapters: [{ id: 'one', title: 'One', content: '<p>hello</p>', lastModified: 1 }],
  }, { createOnly: true });

  // ── 1. Gating ───────────────────────────────────────────────────────────────
  await withApp(false, async (base) => {
    const r = await fetch(`${base}/api/backup/export`, { method: 'POST' });
    check('LOCAL_ADMIN off → /api/backup/export is 404', r.status === 404);
    const s = await fetch(`${base}/api/backup/status`);
    check('LOCAL_ADMIN off → /api/backup/status is 404 (probe fails cleanly)', s.status === 404);
  });
  await withApp(true, async (base) => {
    const s = await fetch(`${base}/api/backup/status`);
    check('LOCAL_ADMIN on → /api/backup/status is 200', s.status === 200);
    const r = await fetch(`${base}/api/backup/export`, { method: 'POST' });
    check('LOCAL_ADMIN on → export responds 200', r.status === 200);
    const buf = Buffer.from(await r.arrayBuffer());
    check('export streams an xz-compressed body', buf.subarray(0, 6).equals(XZ_MAGIC), `magic=${buf.subarray(0,6).toString('hex')}`);
    check('export is a .chron attachment', /\.chron"/.test(r.headers.get('content-disposition') || ''));
  });

  // ── 2. Round-trip: export now, mutate, import the old snapshot, boot-swap ─────
  const snapshot = await exportChron(db, dataDir);
  check('a .chron export is produced', snapshot.length > 0 && snapshot.subarray(0, 6).equals(XZ_MAGIC));

  // Diverge: wipe the manuscript from the live DB entirely.
  db.prepare('DELETE FROM manuscripts WHERE user_id = ? AND id = ?').run('local', 'book');
  db.prepare('DELETE FROM chapters WHERE user_id = ? AND manuscript_id = ?').run('local', 'book');
  check('manuscript is gone before import', loadManuscript('local', 'book') === null);

  const { safetyBackup } = await stageImportChron(db, dataDir, snapshot);
  check('a pre-restore safety backup was written', fs.existsSync(safetyBackup));
  check('the import is staged (marker + staged db present)',
    fs.existsSync(path.join(dataDir, 'import-staged.db')) && fs.existsSync(path.join(dataDir, 'import-staged.marker')));

  // Boot sequence: close the live handle, apply the swap, reopen.
  db.close();
  const applied = applyPendingImport(dataDir);
  check('applyPendingImport reports it swapped', applied === true);
  check('marker and staged file are consumed', !fs.existsSync(path.join(dataDir, 'import-staged.marker')) && !fs.existsSync(path.join(dataDir, 'import-staged.db')));

  const reopened = new Database(primaryDbPath(dataDir), { readonly: true });
  const row = reopened.prepare("SELECT data FROM manuscripts WHERE user_id='local' AND id='book' AND deleted_at IS NULL").get() as { data: string } | undefined;
  reopened.close();
  check('the imported database restored the manuscript', !!row && JSON.parse(row!.data).title === 'The Original');

  // ── 3. Bad input is rejected, not applied ─────────────────────────────────────
  await assert.rejects(
    stageImportChron(new Database(primaryDbPath(dataDir), { readonly: true }), dataDir, Buffer.from('not xz')),
    /valid \.chron/,
    'garbage bytes must be rejected',
  );
  check('a second call with garbage did not stage anything', !fs.existsSync(path.join(dataDir, 'import-staged.marker')));

  console.log(failures === 0 ? '\nall backup checks passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
