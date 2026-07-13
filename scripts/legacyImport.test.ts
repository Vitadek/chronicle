import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-legacy-import-'));
const manuscriptDir = path.join(dataDir, 'manuscripts');
fs.mkdirSync(manuscriptDir, { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.STORAGE_REPLICA = 'none';
process.env.NODE_ENV = 'test';

const { db, LOCAL_USER_ID } = await import('../server/db');
const { importLegacyManuscripts } = await import('../server/scripts/migrate');
const { storage } = await import('../server/lib/storage/HybridManager');

function writeLegacy(lastModified: number, content: string): void {
  fs.writeFileSync(path.join(manuscriptDir, `legacy-${lastModified}.json`), JSON.stringify({
    metadata: {
      id: 'legacy-book',
      title: 'Imported',
      author: 'Legacy Author',
      lastModified,
    },
    chapters: [{
      id: 'legacy-chapter',
      title: 'One',
      content,
      lastModified,
    }],
  }));
}

try {
  const firstTimestamp = Date.now() + 10_000;
  writeLegacy(firstTimestamp, '<p>first import</p>');
  importLegacyManuscripts();
  const initial = db.prepare(`
    SELECT revision FROM manuscripts WHERE user_id = ? AND id = 'legacy-book'
  `).get(LOCAL_USER_ID) as { revision: number };
  assert(initial.revision >= 2, 'child import did not advance aggregate revision');
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM change_log
      WHERE user_id = ? AND record_id IN ('legacy-book', 'legacy-chapter')
    `).get(LOCAL_USER_ID) as { count: number }).count >= 2,
    true,
  );

  writeLegacy(firstTimestamp + 10_000, '<p>updated import</p>');
  importLegacyManuscripts();
  const updated = db.prepare(`
    SELECT revision FROM manuscripts WHERE user_id = ? AND id = 'legacy-book'
  `).get(LOCAL_USER_ID) as { revision: number };
  assert(updated.revision > initial.revision);
  assert.equal(
    (db.prepare(`
      SELECT content FROM chapters
      WHERE user_id = ? AND manuscript_id = 'legacy-book' AND id = 'legacy-chapter'
    `).get(LOCAL_USER_ID) as { content: string }).content,
    '<p>updated import</p>',
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM storage_replica_manifest
      WHERE key LIKE 'v1/users/local/manuscripts/legacy-book/%'
    `).get() as { count: number }).count,
    2,
  );

  console.log('PASS legacy imports participate in revisions, sync log, and replica manifest');
} finally {
  storage.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
