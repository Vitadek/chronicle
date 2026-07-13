import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-restore-apply-'));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_REPLICA = 'none';
process.env.NODE_ENV = 'test';

const { db, LOCAL_USER_ID } = await import('../server/db');
const {
  parsePortableChapter,
  portableChapterKey,
  seedPortableDatabaseManifest,
  serializePortableChapter,
  serializePortableChapterTombstone,
} = await import('../server/lib/portableReplica');
const { applyRestorePlan } = await import('../server/lib/restoreApply');
const { storage } = await import('../server/lib/storage/HybridManager');
const { getSyncHistoryEpoch } = await import('../server/lib/syncHistory');

try {
  db.prepare(`
    INSERT INTO manuscripts(user_id, id, data, last_modified, deleted_at, revision)
    VALUES (?, 'restored-book', ?, 900, NULL, 5)
  `).run(
    LOCAL_USER_ID,
    JSON.stringify({ id: 'restored-book', title: 'local manuscript secret' }),
  );
  const insertChapter = db.prepare(`
    INSERT INTO chapters(
      user_id, manuscript_id, id, title, content, position,
      last_modified, deleted_at, revision
    ) VALUES (?, 'restored-book', ?, ?, ?, ?, ?, NULL, ?)
  `);
  insertChapter.run(
    LOCAL_USER_ID,
    'absent-child',
    'Absent title secret',
    '<p>absent child prose secret</p>',
    0,
    900,
    7,
  );
  insertChapter.run(
    LOCAL_USER_ID,
    'replicated-child',
    'Replicated title secret',
    '<p>replicated child prose secret</p>',
    1,
    800,
    4,
  );
  db.prepare('INSERT INTO ydocs(name, data, updated_at) VALUES (?, ?, ?)').run(
    'local/restored-book:absent-child',
    Buffer.from('late collaborative prose secret'),
    900,
  );
  db.prepare(`
    INSERT INTO chapter_pre_collab(
      user_id, manuscript_id, chapter_id, content, backed_up_at
    ) VALUES (?, 'restored-book', 'absent-child', '<p>backup prose secret</p>', 900)
  `).run(LOCAL_USER_ID);
  const staleCoverKey = 'covers/local/restored-book.stale.png';
  const staleCover = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  storage.restoreLocalBlob(staleCoverKey, staleCover, 'image/png');

  // Exercise the inverse revision ordering: portable history is ahead of the
  // current local token. An in-place restore must still issue a token strictly
  // greater than both histories for every optimistic record type.
  db.prepare(`
    INSERT INTO manuscripts(user_id, id, data, last_modified, deleted_at, revision)
    VALUES (?, 'portable-ahead', ?, 100, NULL, 2)
  `).run(
    LOCAL_USER_ID,
    JSON.stringify({ id: 'portable-ahead', title: 'old local metadata' }),
  );
  db.prepare(`
    INSERT INTO chapters(
      user_id, manuscript_id, id, title, content, position,
      last_modified, deleted_at, revision
    ) VALUES (
      ?, 'portable-ahead', 'portable-ahead-child',
      'Old local chapter', '<p>old local chapter</p>', 0, 100, NULL, 3
    )
  `).run(LOCAL_USER_ID);
  db.prepare(`
    INSERT INTO profiles(user_id, data, last_modified, revision)
    VALUES (?, '{"displayName":"old local profile"}', 100, 4)
  `).run(LOCAL_USER_ID);

  const portableAheadChapter = parsePortableChapter(serializePortableChapter({
    userId: LOCAL_USER_ID,
    manuscriptId: 'portable-ahead',
    id: 'portable-ahead-child',
    title: 'Restored chapter',
    position: 0,
    revision: 12,
    lastModified: 1_200,
  }, '<p>restored chapter</p>'));
  const epochBeforeRestore = getSyncHistoryEpoch();

  const replicatedChapterTombstone = parsePortableChapter(
    serializePortableChapterTombstone({
      userId: LOCAL_USER_ID,
      manuscriptId: 'restored-book',
      id: 'replicated-child',
      revision: 3,
      deletedAt: 400,
    }),
  );
  const legacyCursorBeforeRestore = Date.now();
  const result = applyRestorePlan({
    manuscripts: [{
      record: {
        schemaVersion: 1,
        kind: 'manuscript-tombstone',
        userId: LOCAL_USER_ID,
        id: 'restored-book',
        revision: 2,
        deletedAt: 500,
      },
    }, {
      record: {
        schemaVersion: 1,
        kind: 'manuscript',
        userId: LOCAL_USER_ID,
        id: 'portable-ahead',
        revision: 10,
        lastModified: 1_200,
        metadata: {
          id: 'portable-ahead',
          title: 'Restored metadata',
          author: 'Restore test',
          lastModified: 1_200,
        },
      },
    }],
    chapters: [
      { record: replicatedChapterTombstone },
      { record: portableAheadChapter },
    ],
    profiles: [{
      record: {
        schemaVersion: 1,
        kind: 'profile',
        userId: LOCAL_USER_ID,
        revision: 14,
        lastModified: 1_200,
        profile: { displayName: 'restored profile' },
      },
    }],
    blobs: [{
      remoteKey: 'v1/users/local/covers/restored-book.stale.png',
      localKey: staleCoverKey,
      userId: LOCAL_USER_ID,
      contentType: 'image/png',
      content: staleCover,
    }],
  });
  assert.deepEqual(result, { cascadedChapters: 1, skippedCovers: 1 });
  assert.notEqual(
    getSyncHistoryEpoch(),
    epochBeforeRestore,
    'restore apply did not rotate the durable sync-history epoch',
  );
  assert.equal(
    await storage.get(staleCoverKey),
    null,
    'forced restore retained a stale cover beneath a parent tombstone',
  );

  assert.equal(
    (db.prepare(`
      SELECT revision FROM manuscripts WHERE user_id = ? AND id = 'portable-ahead'
    `).get(LOCAL_USER_ID) as { revision: number }).revision,
    11,
    'portable-ahead manuscript revision was reused',
  );
  assert.equal(
    (db.prepare(`
      SELECT revision FROM chapters
      WHERE user_id = ? AND manuscript_id = 'portable-ahead'
        AND id = 'portable-ahead-child'
    `).get(LOCAL_USER_ID) as { revision: number }).revision,
    13,
    'portable-ahead chapter revision was reused',
  );
  assert.equal(
    (db.prepare('SELECT revision FROM profiles WHERE user_id = ?').get(
      LOCAL_USER_ID,
    ) as { revision: number }).revision,
    15,
    'portable-ahead profile revision was reused',
  );

  const parent = db.prepare(`
    SELECT data, last_modified, deleted_at, revision FROM manuscripts
    WHERE user_id = ? AND id = 'restored-book'
  `).get(LOCAL_USER_ID) as {
    data: string;
    last_modified: number;
    deleted_at: number;
    revision: number;
  };
  assert.deepEqual(JSON.parse(parent.data), { id: 'restored-book' });
  assert(parent.last_modified > legacyCursorBeforeRestore);
  assert.equal(parent.deleted_at, parent.last_modified);
  assert.equal(parent.revision, 6, 'forced restore reused an old parent revision');

  const children = db.prepare(`
    SELECT id, title, content, position, last_modified, deleted_at, revision
    FROM chapters WHERE user_id = ? AND manuscript_id = 'restored-book'
    ORDER BY id
  `).all(LOCAL_USER_ID) as Array<{
    id: string;
    title: string | null;
    content: string | null;
    position: number | null;
    last_modified: number;
    deleted_at: number;
    revision: number;
  }>;
  assert.deepEqual(children.map(({ id, title, content, position, revision }) => ({
    id,
    title,
    content,
    position,
    revision,
  })), [
    {
      id: 'absent-child',
      title: null,
      content: null,
      position: null,
      revision: 8,
    },
    {
      id: 'replicated-child',
      title: null,
      content: null,
      position: null,
      revision: 5,
    },
  ]);
  for (const child of children) {
    assert(child.last_modified > legacyCursorBeforeRestore);
    assert.equal(child.deleted_at, child.last_modified);
  }
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM ydocs
      WHERE name LIKE '%restored-book:%'
    `).get() as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM chapter_pre_collab
      WHERE user_id = ? AND manuscript_id = 'restored-book'
    `).get(LOCAL_USER_ID) as { n: number }).n,
    0,
  );

  const seeded = seedPortableDatabaseManifest();
  assert.equal(seeded.checked, 6);
  for (const id of ['absent-child', 'replicated-child']) {
    const row = db.prepare(`
      SELECT operation, payload FROM storage_replica_manifest WHERE key = ?
    `).get(portableChapterKey(LOCAL_USER_ID, 'restored-book', id)) as {
      operation: string;
      payload: Buffer;
    };
    assert.equal(row.operation, 'put');
    assert.equal(parsePortableChapter(Buffer.from(row.payload)).metadata.kind, 'chapter-tombstone');
    assert(!row.payload.includes(Buffer.from('prose secret')));
    assert(!row.payload.includes(Buffer.from('title secret')));
  }
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM chapters
      WHERE user_id = ? AND manuscript_id = 'restored-book' AND deleted_at IS NULL
    `).get(LOCAL_USER_ID) as { n: number }).n,
    0,
    'post-restore seed could republish a live child beneath a parent tombstone',
  );

  console.log('PASS importable forced-restore tombstone cascade and privacy invariants');
} finally {
  storage.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
