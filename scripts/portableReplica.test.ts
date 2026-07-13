import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-portable-replica-'));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_REPLICA = 'none';
process.env.NODE_ENV = 'test';

const { db, LOCAL_USER_ID } = await import('../server/db');
const {
  deleteChapter,
  deleteManuscript,
  loadManuscript,
  saveLegacyManuscript,
} = await import('../server/lib/manuscriptRepository');
const {
  parsePortableChapter,
  portableChapterKey,
  portableManuscriptKey,
  reconcileReplicaTarget,
  seedPortableDatabaseManifest,
} = await import('../server/lib/portableReplica');
const { storage } = await import('../server/lib/storage/HybridManager');

try {
  const content = '<p>literal </body> marker — café 📚</p>\n<!-- chronicle-like text -->';
  saveLegacyManuscript(LOCAL_USER_ID, {
    metadata: {
      id: 'portable-book',
      title: 'Portable Book',
      author: 'Test Author',
      lastModified: 1,
    },
    chapters: [{
      id: 'chapter-one',
      title: 'One & <Only>',
      content,
      lastModified: 1,
    }, {
      id: 'chapter-two',
      title: 'Secret second chapter',
      content: '<p>second chapter prose must disappear from tombstone</p>',
      lastModified: 1,
    }],
  });

  const chapterKey = portableChapterKey(LOCAL_USER_ID, 'portable-book', 'chapter-one');
  const manuscriptKey = portableManuscriptKey(LOCAL_USER_ID, 'portable-book');
  const chapterManifest = db.prepare(`
    SELECT operation, payload, generation FROM storage_replica_manifest WHERE key = ?
  `).get(chapterKey) as { operation: string; payload: Buffer; generation: number };
  assert.equal(chapterManifest.operation, 'put');
  assert.equal(parsePortableChapter(Buffer.from(chapterManifest.payload)).content, content);

  const generationsBefore = new Map(
    (db.prepare(`
      SELECT key, generation FROM storage_replica_manifest WHERE key IN (?, ?)
    `).all(manuscriptKey, chapterKey) as Array<{ key: string; generation: number }>)
      .map((row) => [row.key, row.generation]),
  );
  assert.deepEqual(seedPortableDatabaseManifest(), { checked: 3, enqueued: 0 });
  assert.deepEqual(seedPortableDatabaseManifest(), { checked: 3, enqueued: 0 });
  const generationsAfter = new Map(
    (db.prepare(`
      SELECT key, generation FROM storage_replica_manifest WHERE key IN (?, ?)
    `).all(manuscriptKey, chapterKey) as Array<{ key: string; generation: number }>)
      .map((row) => [row.key, row.generation]),
  );
  assert.deepEqual(generationsAfter, generationsBefore, 'restart seed advanced a generation');

  // Simulate an upgrade from a build that had authoritative rows but no
  // portable manifest. Startup seeding must repair exactly the missing record.
  db.prepare('DELETE FROM storage_replica_manifest WHERE key = ?').run(manuscriptKey);
  assert.deepEqual(seedPortableDatabaseManifest(), { checked: 3, enqueued: 1 });
  assert.ok(
    db.prepare('SELECT 1 FROM storage_replica_manifest WHERE key = ?').get(manuscriptKey),
  );

  const coverKey = 'covers/local/portable-book.abcdef.png';
  await storage.put(
    coverKey,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    'image/png',
  );

  const chapterRevision = loadManuscript(LOCAL_USER_ID, 'portable-book')!
    .chapters.find((chapter) => chapter.id === 'chapter-one')!.revision;
  const chapterDelete = deleteChapter(
    LOCAL_USER_ID,
    'portable-book',
    'chapter-one',
    chapterRevision,
  );
  assert(chapterDelete && chapterDelete.ok === true);
  const chapterTombstoneRow = db.prepare(`
    SELECT operation, payload FROM storage_replica_manifest WHERE key = ?
  `).get(chapterKey) as { operation: string; payload: Buffer };
  assert.equal(chapterTombstoneRow.operation, 'put');
  const chapterTombstone = parsePortableChapter(Buffer.from(chapterTombstoneRow.payload));
  assert.equal(chapterTombstone.metadata.kind, 'chapter-tombstone');
  assert.equal(chapterTombstone.content, '');
  assert(!chapterTombstoneRow.payload.includes(Buffer.from('literal </body> marker')));
  assert(!chapterTombstoneRow.payload.includes(Buffer.from('One & <Only>')));

  const beforeBookDelete = loadManuscript(LOCAL_USER_ID, 'portable-book')!;
  const bookDelete = deleteManuscript(
    LOCAL_USER_ID,
    'portable-book',
    beforeBookDelete.metadata.revision,
  );
  assert(bookDelete && bookDelete.ok === true);
  const manuscriptTombstoneRow = db.prepare(`
    SELECT operation, payload FROM storage_replica_manifest WHERE key = ?
  `).get(manuscriptKey) as { operation: string; payload: Buffer };
  assert.equal(manuscriptTombstoneRow.operation, 'put');
  const manuscriptTombstone = JSON.parse(manuscriptTombstoneRow.payload.toString('utf8')) as {
    kind: string;
    metadata?: unknown;
  };
  assert.equal(manuscriptTombstone.kind, 'manuscript-tombstone');
  assert.equal(manuscriptTombstone.metadata, undefined);
  assert(!manuscriptTombstoneRow.payload.includes(Buffer.from('Portable Book')));

  const chapterTwoKey = portableChapterKey(LOCAL_USER_ID, 'portable-book', 'chapter-two');
  const cascaded = db.prepare(
    'SELECT operation, payload FROM storage_replica_manifest WHERE key = ?',
  ).get(chapterTwoKey) as { operation: string; payload: Buffer };
  assert.equal(cascaded.operation, 'put');
  assert.equal(parsePortableChapter(Buffer.from(cascaded.payload)).metadata.kind, 'chapter-tombstone');
  assert(!cascaded.payload.includes(Buffer.from('second chapter prose')));

  assert.equal(await storage.get(coverKey), null);
  const coverManifest = db.prepare(`
    SELECT operation, payload FROM storage_replica_manifest
    WHERE key = 'v1/users/local/covers/portable-book.abcdef.png'
  `).get() as { operation: string; payload: Buffer | null };
  assert.equal(coverManifest.operation, 'delete');
  assert.equal(coverManifest.payload, null);

  const tombstoneGenerations = db.prepare(`
    SELECT key, generation FROM storage_replica_manifest ORDER BY key
  `).all() as Array<{ key: string; generation: number }>;
  assert.deepEqual(seedPortableDatabaseManifest(), { checked: 3, enqueued: 0 });
  assert.deepEqual(seedPortableDatabaseManifest(), { checked: 3, enqueued: 0 });
  assert.deepEqual(
    db.prepare('SELECT key, generation FROM storage_replica_manifest ORDER BY key').all(),
    tombstoneGenerations,
    'idempotent tombstone seed advanced a generation',
  );

  assert.deepEqual(reconcileReplicaTarget(), { changed: true, seeded: 0 });
  assert.deepEqual(reconcileReplicaTarget(), { changed: false, seeded: 0 });
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM storage_replication_outbox').get() as { n: number }).n,
    0,
    'disabled replication unexpectedly created network jobs',
  );

  console.log('PASS portable replica round-trip, tombstones, cover cleanup, and bootstrap');
} finally {
  storage.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
