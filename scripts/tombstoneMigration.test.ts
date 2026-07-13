import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-tombstone-migration-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const fixture = new Database(path.join(dataDir, 'chronicle.db'));
fixture.exec(`
  CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
  CREATE TABLE users(
    id TEXT PRIMARY KEY, email TEXT, display_name TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions(token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at INTEGER);
  CREATE TABLE manuscripts(
    user_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
    last_modified INTEGER NOT NULL, deleted_at INTEGER, revision INTEGER NOT NULL,
    PRIMARY KEY(user_id, id)
  );
  CREATE TABLE chapters(
    user_id TEXT NOT NULL, manuscript_id TEXT NOT NULL, id TEXT NOT NULL,
    title TEXT, content TEXT, position INTEGER, last_modified INTEGER NOT NULL,
    deleted_at INTEGER, revision INTEGER NOT NULL,
    PRIMARY KEY(user_id, manuscript_id, id)
  );
  CREATE TABLE ydocs(name TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE chapter_pre_collab(
    user_id TEXT NOT NULL, manuscript_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
    content TEXT NOT NULL, backed_up_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, manuscript_id, chapter_id)
  );
  CREATE TABLE change_log(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, entity TEXT NOT NULL,
    manuscript_id TEXT, record_id TEXT NOT NULL, operation TEXT NOT NULL,
    revision INTEGER NOT NULL, changed_at INTEGER NOT NULL
  );
`);
const insertMigration = fixture.prepare(
  'INSERT INTO schema_migrations(name, applied_at) VALUES (?, 1)',
);
for (const name of [
  '001_init',
  '002_external_identity',
  '003_plugin_system',
  '004_fix_plugin_states_fk',
  '005_collab_ydocs',
  '006_chapter_pre_collab',
  '007_record_revisions',
]) insertMigration.run(name);
fixture.prepare(`
  INSERT INTO users(id, display_name, created_at)
  VALUES ('local', 'Local User', 1), ('oidc:alice', 'Alice', 1)
`).run();
fixture.prepare(`
  INSERT INTO manuscripts(user_id, id, data, last_modified, deleted_at, revision)
  VALUES ('local', 'deleted-book', ?, 500, 500, 5),
         ('local', 'live-book', ?, 600, NULL, 2)
`).run(
  JSON.stringify({ id: 'deleted-book', title: 'old deleted metadata secret' }),
  JSON.stringify({ id: 'live-book', title: 'must remain live' }),
);
fixture.prepare(`
  INSERT INTO manuscripts(user_id, id, data, last_modified, deleted_at, revision)
  VALUES ('oidc:alice', 'oidc-deleted-book', ?, 800, 800, 6)
`).run(JSON.stringify({ id: 'oidc-deleted-book', title: 'OIDC metadata secret' }));
const insertChapter = fixture.prepare(`
  INSERT INTO chapters(
    user_id, manuscript_id, id, title, content, position,
    last_modified, deleted_at, revision
  ) VALUES ('local', ?, ?, ?, ?, 0, ?, ?, ?)
`);
insertChapter.run(
  'deleted-book',
  'inconsistent-live-child',
  'live orphan title secret',
  '<p>live orphan prose secret</p>',
  900,
  null,
  7,
);
insertChapter.run(
  'deleted-book',
  'old-deleted-child',
  'deleted title secret',
  '<p>deleted prose secret</p>',
  400,
  400,
  4,
);
insertChapter.run(
  'live-book',
  'deleted-under-live',
  'other deleted title secret',
  '<p>other deleted prose secret</p>',
  700,
  700,
  3,
);
fixture.prepare(`
  INSERT INTO chapters(
    user_id, manuscript_id, id, title, content, position,
    last_modified, deleted_at, revision
  ) VALUES (
    'oidc:alice', 'oidc-deleted-book', 'oidc-child',
    'OIDC title secret', '<p>OIDC prose secret</p>', 0, 810, 810, 4
  )
`).run();
const insertYdoc = fixture.prepare(
  'INSERT INTO ydocs(name, data, updated_at) VALUES (?, ?, 1)',
);
for (const name of [
  'local/deleted-book:inconsistent-live-child',
  'deleted-book:old-deleted-child',
  'local/live-book:deleted-under-live',
  'oidc%3Aalice/oidc-deleted-book:oidc-child',
  // This row came from the old globally-unscoped OIDC client. Migration 008
  // must scrub it too; limiting legacy cleanup to user "local" leaks prose.
  'oidc-deleted-book:oidc-child',
]) insertYdoc.run(name, Buffer.from(`ydoc secret ${name}`));
const insertBackup = fixture.prepare(`
  INSERT INTO chapter_pre_collab(
    user_id, manuscript_id, chapter_id, content, backed_up_at
  ) VALUES ('local', ?, ?, '<p>backup secret</p>', 1)
`);
insertBackup.run('deleted-book', 'inconsistent-live-child');
insertBackup.run('live-book', 'deleted-under-live');
fixture.close();

const { db } = await import('../server/db');
try {
  assert.deepEqual(
    JSON.parse((db.prepare(`
      SELECT data FROM manuscripts WHERE user_id = 'local' AND id = 'deleted-book'
    `).get() as { data: string }).data),
    { id: 'deleted-book' },
  );
  assert.equal(
    (JSON.parse((db.prepare(`
      SELECT data FROM manuscripts WHERE user_id = 'local' AND id = 'live-book'
    `).get() as { data: string }).data) as { title: string }).title,
    'must remain live',
  );
  const children = db.prepare(`
    SELECT manuscript_id, id, title, content, position, last_modified, deleted_at, revision
    FROM chapters ORDER BY manuscript_id, id
  `).all() as Array<{
    manuscript_id: string;
    id: string;
    title: string | null;
    content: string | null;
    position: number | null;
    last_modified: number;
    deleted_at: number;
    revision: number;
  }>;
  assert(children.every((row) =>
    row.title === null && row.content === null && row.position === null
  ));
  const repaired = children.find((row) => row.id === 'inconsistent-live-child')!;
  assert.equal(repaired.deleted_at, 900);
  assert.equal(repaired.last_modified, 900);
  assert.equal(repaired.revision, 8);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM change_log
      WHERE entity = 'chapter' AND manuscript_id = 'deleted-book'
        AND record_id = 'inconsistent-live-child' AND operation = 'delete'
    `).get() as { n: number }).n,
    1,
    'idempotent startup scrub advanced/logged the repaired child twice',
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ydocs').get() as { n: number }).n, 0);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM chapter_pre_collab').get() as { n: number }).n,
    0,
  );
  assert(db.prepare(`
    SELECT 1 FROM schema_migrations WHERE name = '008_scrub_tombstone_payloads'
  `).get());

  console.log('PASS pre-migration tombstone privacy and orphan-child repair');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
