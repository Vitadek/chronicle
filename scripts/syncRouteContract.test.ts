import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { JSDOM } from 'jsdom';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-sync-route-'));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_REPLICA = 'none';
process.env.NODE_ENV = 'test';

const { default: syncRouter } = await import('../server/routes/sync');
const { LOCAL_USER_ID, db } = await import('../server/db');
const { storage } = await import('../server/lib/storage/HybridManager');
const { getSyncHistoryEpoch, rotateSyncHistoryEpoch } = await import(
  '../server/lib/syncHistory'
);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.userId = LOCAL_USER_ID;
  next();
});
app.use('/api/sync', syncRouter);

const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const legacy = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ since: 0, push: {} }),
  });
  const legacyText = await legacy.text();
  assert.equal(legacy.status, 200, legacyText);
  const legacyBody = JSON.parse(legacyText) as { pull?: { manuscripts?: unknown[] } };
  assert.deepEqual(legacyBody.pull?.manuscripts, []);

  const orphan = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      since: 0,
      push: {
        chapters: [{
          id: 'orphan',
          manuscript_id: 'missing',
          title: 'Orphan',
          content: '<p>must not be inserted</p>',
          position: 0,
          last_modified: 1,
        }],
      },
    }),
  });
  assert.equal(orphan.status, 200, await orphan.clone().text());
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number }).n,
    0,
  );

  const create = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      since: 0,
      push: {
        manuscripts: [{ id: 'book', data: '{"title":"Book"}', last_modified: 100 }],
        chapters: [{
          id: 'chapter',
          manuscript_id: 'book',
          title: 'Chapter',
          content: '<p>live</p>',
          position: 0,
          last_modified: 100,
        }],
      },
    }),
  });
  assert.equal(create.status, 200, await create.clone().text());

  // v1 chapter timestamps come from client wall clocks. A newly seen child
  // from a slow device may be older than its parent without moving the
  // aggregate parent clock backward.
  const slowClockChild = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      since: 0,
      push: {
        manuscripts: [{
          id: 'clock-book',
          data: '{"id":"clock-book","title":"Clock Book","lastModified":10000}',
          last_modified: 10_000,
        }],
        chapters: [{
          id: 'slow-child',
          manuscript_id: 'clock-book',
          title: 'Slow child',
          content: '<p>old clock, new record</p>',
          position: 0,
          last_modified: 1,
        }],
      },
    }),
  });
  assert.equal(slowClockChild.status, 200, await slowClockChild.clone().text());
  const clockParent = db.prepare(`
    SELECT data, last_modified FROM manuscripts
    WHERE user_id = ? AND id = 'clock-book'
  `).get(LOCAL_USER_ID) as { data: string; last_modified: number };
  assert.equal(clockParent.last_modified, 10_000);
  assert.equal(
    (JSON.parse(clockParent.data) as { lastModified: number }).lastModified,
    10_000,
  );

  db.prepare('INSERT INTO ydocs(name, data, updated_at) VALUES (?, ?, ?)').run(
    'local/book:chapter',
    Buffer.from('v1 deleted ydoc prose'),
    Date.now(),
  );
  db.prepare(`
    INSERT INTO chapter_pre_collab(
      user_id, manuscript_id, chapter_id, content, backed_up_at
    ) VALUES (?, 'book', 'chapter', '<p>v1 deleted backup prose</p>', ?)
  `).run(LOCAL_USER_ID, Date.now());

  const deleteWithStaleChild = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      since: 0,
      push: {
        manuscripts: [{
          id: 'book',
          data: '{"title":"Book"}',
          last_modified: 200,
          deleted: true,
        }],
        chapters: [{
          id: 'chapter',
          manuscript_id: 'book',
          title: 'Chapter',
          content: '<p>attempted resurrection</p>',
          position: 0,
          last_modified: 300,
        }],
      },
    }),
  });
  const deleteWithStaleChildText = await deleteWithStaleChild.text();
  assert.equal(deleteWithStaleChild.status, 200, deleteWithStaleChildText);
  assert(!deleteWithStaleChildText.includes('<p>live</p>'));
  assert(!deleteWithStaleChildText.includes('attempted resurrection'));
  const deletedChapter = db.prepare(`
    SELECT title, content, position, deleted_at FROM chapters
    WHERE user_id = ? AND manuscript_id = 'book' AND id = 'chapter'
  `).get(LOCAL_USER_ID) as {
    title: string | null;
    content: string | null;
    position: number | null;
    deleted_at: number | null;
  };
  assert.notEqual(deletedChapter.deleted_at, null);
  assert.equal(deletedChapter.title, null);
  assert.equal(deletedChapter.content, null);
  assert.equal(deletedChapter.position, null);
  const deletedMetadata = db.prepare(`
    SELECT data FROM manuscripts WHERE user_id = ? AND id = 'book'
  `).get(LOCAL_USER_ID) as { data: string };
  assert.deepEqual(JSON.parse(deletedMetadata.data), { id: 'book' });
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM ydocs WHERE name = 'local/book:chapter'
    `).get() as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM chapter_pre_collab
      WHERE user_id = ? AND manuscript_id = 'book'
    `).get(LOCAL_USER_ID) as { n: number }).n,
    0,
  );

  const futureClockResurrection = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      since: 0,
      push: {
        manuscripts: [{
          id: 'book',
          data: '{"title":"resurrected"}',
          last_modified: Number.MAX_SAFE_INTEGER,
        }],
      },
    }),
  });
  assert.equal(futureClockResurrection.status, 200, await futureClockResurrection.clone().text());
  assert.notEqual(
    (db.prepare(`
      SELECT deleted_at FROM manuscripts WHERE user_id = ? AND id = 'book'
    `).get(LOCAL_USER_ID) as { deleted_at: number | null }).deleted_at,
    null,
    'future-clock v1 writer resurrected a manuscript tombstone',
  );

  const v2CreateBook = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursor: 0,
      changes: [{
        entity: 'manuscript',
        operation: 'upsert',
        id: 'v2-private',
        baseRevision: 0,
        data: '{"id":"v2-private","title":"v2 manuscript metadata secret"}',
      }],
    }),
  });
  assert.equal(v2CreateBook.status, 200, await v2CreateBook.clone().text());

  // The first accepted result in a batch must carry the final token after a
  // later child mutation advances the aggregate manuscript revision.
  const tokenBatch = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursor: 0,
      changes: [{
        entity: 'manuscript',
        operation: 'upsert',
        id: 'v2-result-tokens',
        baseRevision: 0,
        data: '{"id":"v2-result-tokens","title":"Token batch"}',
      }, {
        entity: 'chapter',
        operation: 'upsert',
        manuscriptId: 'v2-result-tokens',
        id: 'token-child',
        baseRevision: 0,
        title: 'Token child',
        content: '<p>token child</p>',
        position: 0,
      }],
    }),
  });
  const tokenBatchBody = await tokenBatch.json() as {
    results: Array<{
      entity: string;
      id: string;
      status: string;
      revision: number;
    }>;
  };
  assert.equal(tokenBatch.status, 200);
  const manuscriptToken = tokenBatchBody.results.find(
    (result) => result.entity === 'manuscript' && result.id === 'v2-result-tokens',
  );
  assert.equal(manuscriptToken?.status, 'accepted');
  assert.equal(
    manuscriptToken?.revision,
    (db.prepare(`
      SELECT revision FROM manuscripts WHERE user_id = ? AND id = 'v2-result-tokens'
    `).get(LOCAL_USER_ID) as { revision: number }).revision,
    'accepted batch result returned a revision already made stale by its child mutation',
  );
  const v2CreateChapters = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursor: 0,
      changes: [
        {
          entity: 'chapter',
          operation: 'upsert',
          manuscriptId: 'v2-private',
          id: 'explicit-delete',
          baseRevision: 0,
          title: 'v2 explicit title secret',
          content: '<p>v2 explicit prose secret</p>',
          position: 0,
        },
        {
          entity: 'chapter',
          operation: 'upsert',
          manuscriptId: 'v2-private',
          id: 'cascade-delete',
          baseRevision: 0,
          title: 'v2 cascade title secret',
          content: '<p>v2 cascade prose secret</p>',
          position: 1,
        },
      ],
    }),
  });
  assert.equal(v2CreateChapters.status, 200, await v2CreateChapters.clone().text());
  for (const chapterId of ['explicit-delete', 'cascade-delete']) {
    db.prepare('INSERT INTO ydocs(name, data, updated_at) VALUES (?, ?, ?)').run(
      `local/v2-private:${chapterId}`,
      Buffer.from(`v2 ${chapterId} ydoc secret`),
      Date.now(),
    );
    db.prepare(`
      INSERT INTO chapter_pre_collab(
        user_id, manuscript_id, chapter_id, content, backed_up_at
      ) VALUES (?, 'v2-private', ?, ?, ?)
    `).run(
      LOCAL_USER_ID,
      chapterId,
      `<p>v2 ${chapterId} backup secret</p>`,
      Date.now(),
    );
  }

  const v2DeleteChapter = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursor: 0,
      changes: [{
        entity: 'chapter',
        operation: 'delete',
        manuscriptId: 'v2-private',
        id: 'explicit-delete',
        baseRevision: 1,
      }],
    }),
  });
  const v2DeleteChapterText = await v2DeleteChapter.text();
  assert.equal(v2DeleteChapter.status, 200, v2DeleteChapterText);
  assert(!v2DeleteChapterText.includes('v2 explicit prose secret'));
  assert(!v2DeleteChapterText.includes('v2 explicit title secret'));
  const v2ExplicitRow = db.prepare(`
    SELECT title, content, position, deleted_at FROM chapters
    WHERE user_id = ? AND manuscript_id = 'v2-private' AND id = 'explicit-delete'
  `).get(LOCAL_USER_ID) as {
    title: string | null;
    content: string | null;
    position: number | null;
    deleted_at: number | null;
  };
  assert.deepEqual(
    [v2ExplicitRow.title, v2ExplicitRow.content, v2ExplicitRow.position],
    [null, null, null],
  );
  assert.notEqual(v2ExplicitRow.deleted_at, null);

  const v2ParentRevision = (db.prepare(`
    SELECT revision FROM manuscripts WHERE user_id = ? AND id = 'v2-private'
  `).get(LOCAL_USER_ID) as { revision: number }).revision;
  const v2DeleteBook = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursor: 0,
      changes: [{
        entity: 'manuscript',
        operation: 'delete',
        id: 'v2-private',
        baseRevision: v2ParentRevision,
      }],
    }),
  });
  const v2DeleteBookText = await v2DeleteBook.text();
  assert.equal(v2DeleteBook.status, 200, v2DeleteBookText);
  for (const secret of [
    'v2 manuscript metadata secret',
    'v2 explicit prose secret',
    'v2 cascade prose secret',
    'v2 explicit title secret',
    'v2 cascade title secret',
  ]) assert(!v2DeleteBookText.includes(secret), `v2 tombstone response leaked ${secret}`);
  assert.deepEqual(
    JSON.parse((db.prepare(`
      SELECT data FROM manuscripts WHERE user_id = ? AND id = 'v2-private'
    `).get(LOCAL_USER_ID) as { data: string }).data),
    { id: 'v2-private' },
  );
  const v2Rows = db.prepare(`
    SELECT title, content, position FROM chapters
    WHERE user_id = ? AND manuscript_id = 'v2-private'
  `).all(LOCAL_USER_ID) as Array<{
    title: string | null;
    content: string | null;
    position: number | null;
  }>;
  assert(v2Rows.every((row) =>
    row.title === null && row.content === null && row.position === null
  ));
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM ydocs WHERE name LIKE 'local/v2-private:%'
    `).get() as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM chapter_pre_collab
      WHERE user_id = ? AND manuscript_id = 'v2-private'
    `).get(LOCAL_USER_ID) as { n: number }).n,
    0,
  );

  const accidentalOldPath = await fetch(`${base}/api/sync/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(accidentalOldPath.status, 404);

  const currentCursor = (
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log WHERE user_id = ?')
      .get(LOCAL_USER_ID) as { seq: number }
  ).seq;
  const v2 = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor: currentCursor, changes: [] }),
  });
  const v2Text = await v2.text();
  assert.equal(v2.status, 200, v2Text);
  const v2Body = JSON.parse(v2Text) as {
    epoch?: string;
    cursor?: number;
    changes?: unknown[];
  };
  assert.equal(v2Body.epoch, getSyncHistoryEpoch());
  assert.equal(v2Body.cursor, currentCursor);
  assert.deepEqual(v2Body.changes, []);

  const insertChange = db.prepare(`
    INSERT INTO change_log(
      user_id, entity, manuscript_id, record_id, operation, revision, changed_at
    ) VALUES (?, 'manuscript', NULL, 'book', 'delete', 1, ?)
  `);
  db.transaction(() => {
    for (let index = 0; index < 1_001; index += 1) {
      insertChange.run(LOCAL_USER_ID, Date.now());
    }
  })();
  const firstPage = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor: currentCursor, epoch: v2Body.epoch, changes: [] }),
  });
  const firstPageBody = await firstPage.json() as {
    cursor: number;
    hasMore: boolean;
    changes: unknown[];
  };
  assert.equal(firstPage.status, 200);
  assert.equal(firstPageBody.hasMore, true);
  assert(firstPageBody.cursor > currentCursor);
  assert.equal(firstPageBody.changes.length, 1, 'same-record changes should collapse per page');

  const finalPage = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursor: firstPageBody.cursor,
      epoch: v2Body.epoch,
      changes: [],
    }),
  });
  const finalPageBody = await finalPage.json() as { cursor: number; hasMore: boolean };
  assert.equal(finalPage.status, 200);
  assert.equal(finalPageBody.hasMore, false);
  assert(finalPageBody.cursor > firstPageBody.cursor);

  const preRestoreCursor = finalPageBody.cursor + 1_000_000;
  const numericGuardBefore = db.prepare(`
    SELECT data, last_modified, revision FROM manuscripts
    WHERE user_id = ? AND id = 'v2-result-tokens'
  `).get(LOCAL_USER_ID) as {
    data: string;
    last_modified: number;
    revision: number;
  };
  const changeCountBeforeNumericGuard = (db.prepare(`
    SELECT COUNT(*) AS n FROM change_log WHERE user_id = ?
  `).get(LOCAL_USER_ID) as { n: number }).n;
  const restoredServerPull = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursor: preRestoreCursor,
      epoch: v2Body.epoch,
      changes: [{
        entity: 'manuscript',
        operation: 'upsert',
        id: 'v2-result-tokens',
        baseRevision: numericGuardBefore.revision,
        data: '{"id":"v2-result-tokens","title":"numeric cursor overwrite"}',
      }],
    }),
  });
  const restoredServerBody = await restoredServerPull.json() as {
    cursor: number;
    hasMore: boolean;
    reset?: boolean;
    results: Array<{
      status: string;
      reason?: string;
      revision: number;
      current?: { data?: string };
    }>;
    changes: Array<Record<string, unknown>>;
  };
  assert.equal(restoredServerPull.status, 200);
  assert.equal(restoredServerBody.reset, true);
  assert(restoredServerBody.cursor < preRestoreCursor);
  assert.equal(restoredServerBody.results[0].status, 'conflict');
  assert.equal(restoredServerBody.results[0].reason, 'cursor_ahead_of_history');
  assert.equal(restoredServerBody.results[0].revision, numericGuardBefore.revision);
  assert.equal(restoredServerBody.results[0].current?.data, numericGuardBefore.data);
  assert.deepEqual(
    db.prepare(`
      SELECT data, last_modified, revision FROM manuscripts
      WHERE user_id = ? AND id = 'v2-result-tokens'
    `).get(LOCAL_USER_ID),
    numericGuardBefore,
    'a matching revision accompanying a numeric reset mutated server state',
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM change_log WHERE user_id = ?
    `).get(LOCAL_USER_ID) as { n: number }).n,
    changeCountBeforeNumericGuard,
    'a mutation accompanying a numeric reset entered the change log',
  );
  assert(restoredServerBody.changes.length > 0, 'cursor reset did not replay full state');
  const replayedBookDelete = restoredServerBody.changes.find(
    (change) => change.entity === 'manuscript' && change.id === 'book',
  );
  assert(replayedBookDelete, 'cursor reset omitted restored manuscript state');
  assert.equal(replayedBookDelete.operation, 'delete');
  assert(!Object.hasOwn(replayedBookDelete, 'data'));
  const replayedChapterDelete = restoredServerBody.changes.find(
    (change) => change.entity === 'chapter' && change.id === 'chapter',
  );
  assert(replayedChapterDelete, 'cursor reset omitted restored chapter state');
  assert.equal(replayedChapterDelete.operation, 'delete');
  assert(!Object.hasOwn(replayedChapterDelete, 'title'));
  assert(!Object.hasOwn(replayedChapterDelete, 'content'));
  assert(!Object.hasOwn(replayedChapterDelete, 'position'));

  // Numeric cursor comparisons alone cannot detect an old history after new
  // writes catch its sequence up. Rotate the durable epoch, advance beyond the
  // old cursor, and prove the old epoch still forces a full replay.
  const oldEpoch = v2Body.epoch!;
  const oldHistoryCursor = finalPageBody.cursor;
  const rotatedEpoch = rotateSyncHistoryEpoch();
  assert.notEqual(rotatedEpoch, oldEpoch);
  db.transaction(() => {
    for (let index = 0; index < 10; index += 1) {
      insertChange.run(LOCAL_USER_ID, Date.now());
    }
  })();
  const caughtUpCursor = (db.prepare(`
    SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log WHERE user_id = ?
  `).get(LOCAL_USER_ID) as { seq: number }).seq;
  assert(caughtUpCursor > oldHistoryCursor);

  const protectedBefore = db.prepare(`
    SELECT data, last_modified, revision FROM manuscripts
    WHERE user_id = ? AND id = 'v2-result-tokens'
  `).get(LOCAL_USER_ID) as {
    data: string;
    last_modified: number;
    revision: number;
  };
  const changeCountBeforeEpochGuard = (db.prepare(`
    SELECT COUNT(*) AS n FROM change_log WHERE user_id = ?
  `).get(LOCAL_USER_ID) as { n: number }).n;
  const guardedReplicaKey = 'v1/users/local/manuscripts/v2-result-tokens/metadata.json';
  const replicaManifestBeforeEpochGuard = db.prepare(`
    SELECT operation, checksum, generation, updated_at
    FROM storage_replica_manifest WHERE key = ?
  `).get(guardedReplicaKey);

  const epochResetPull = await fetch(`${base}/api/sync/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursor: oldHistoryCursor,
      epoch: oldEpoch,
      changes: [{
        entity: 'manuscript',
        operation: 'upsert',
        id: 'v2-result-tokens',
        // Deliberately matches the restored record. The stale epoch, not a
        // revision mismatch, must prevent this draft from being applied.
        baseRevision: protectedBefore.revision,
        data: '{"id":"v2-result-tokens","title":"stale epoch overwrite"}',
      }],
    }),
  });
  const epochResetBody = await epochResetPull.json() as {
    epoch: string;
    cursor: number;
    reset?: boolean;
    results: Array<{
      entity: string;
      id: string;
      status: string;
      reason?: string;
      revision: number;
      current?: { data?: string };
    }>;
    changes: Array<Record<string, unknown>>;
  };
  assert.equal(epochResetPull.status, 200);
  assert.equal(epochResetBody.epoch, rotatedEpoch);
  assert.equal(epochResetBody.reset, true);
  assert(epochResetBody.changes.length > 0, 'epoch reset did not replay current state');
  assert.deepEqual(epochResetBody.results.map((result) => ({
    entity: result.entity,
    id: result.id,
    status: result.status,
    reason: result.reason,
    revision: result.revision,
  })), [{
    entity: 'manuscript',
    id: 'v2-result-tokens',
    status: 'conflict',
    reason: 'history_epoch_mismatch',
    revision: protectedBefore.revision,
  }]);
  assert.equal(epochResetBody.results[0].current?.data, protectedBefore.data);
  assert.deepEqual(
    db.prepare(`
      SELECT data, last_modified, revision FROM manuscripts
      WHERE user_id = ? AND id = 'v2-result-tokens'
    `).get(LOCAL_USER_ID),
    protectedBefore,
    'a matching revision from the stale history mutated the restored record',
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM change_log WHERE user_id = ?
    `).get(LOCAL_USER_ID) as { n: number }).n,
    changeCountBeforeEpochGuard,
    'a rejected stale-history mutation entered the change log',
  );
  assert.deepEqual(
    db.prepare(`
      SELECT operation, checksum, generation, updated_at
      FROM storage_replica_manifest WHERE key = ?
    `).get(guardedReplicaKey),
    replicaManifestBeforeEpochGuard,
    'a rejected stale-history mutation changed recovery-replica intent',
  );
  const replayedProtectedRecord = epochResetBody.changes.find(
    (change) => change.entity === 'manuscript' && change.id === 'v2-result-tokens',
  );
  assert.equal(
    replayedProtectedRecord?.data,
    protectedBefore.data,
    'reset replay did not retain the authoritative restored record',
  );

  // Browser state keeps the cursor and epoch together per verified user,
  // sends the learned epoch, accepts a lower reset cursor, and clears both.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://chronicle.test/',
  });
  (globalThis as typeof globalThis & { window: Window }).window = dom.window as unknown as Window;
  (globalThis as typeof globalThis & { document: Document }).document = dom.window.document;
  (globalThis as typeof globalThis & { localStorage: Storage }).localStorage = dom.window.localStorage;
  (globalThis as typeof globalThis & { sessionStorage: Storage }).sessionStorage = dom.window.sessionStorage;
  sessionStorage.setItem('chronicle_user_id', 'epoch-adoption-client');
  localStorage.setItem('chronicle_sync_cursor_v2:epoch-adoption-client', '999999');

  const originalFetch = globalThis.fetch;
  const sentBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    assert.equal(typeof init?.body, 'string');
    sentBodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response(JSON.stringify({
      epoch: rotatedEpoch,
      cursor: 3,
      ...(sentBodies.length > 1 ? { reset: true } : {}),
      hasMore: false,
      changes: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const { resetSyncCursor, syncOnce } = await import('../src/services/syncService');
    const adoptionPull = await syncOnce();
    assert.equal(sentBodies[0].cursor, 0, 'an epoch-less cursor skipped initial replay');
    assert.equal(Object.hasOwn(sentBodies[0], 'epoch'), false);
    assert.equal(adoptionPull?.reset, true);
    assert.equal(adoptionPull?.cursor, 3);
    assert.equal(
      localStorage.getItem('chronicle_sync_epoch_v2:epoch-adoption-client'),
      rotatedEpoch,
    );
    resetSyncCursor();
    assert.equal(
      localStorage.getItem('chronicle_sync_cursor_v2:epoch-adoption-client'),
      null,
    );
    assert.equal(
      localStorage.getItem('chronicle_sync_epoch_v2:epoch-adoption-client'),
      null,
    );

    sessionStorage.setItem('chronicle_user_id', 'epoch-client');
    localStorage.setItem('chronicle_sync_cursor_v2:epoch-client', '999999');
    localStorage.setItem('chronicle_sync_epoch_v2:epoch-client', oldEpoch);
    const browserPull = await syncOnce();
    assert.equal(sentBodies[1].cursor, 999999);
    assert.equal(sentBodies[1].epoch, oldEpoch);
    assert.deepEqual(
      sentBodies[1].changes,
      [],
      'the browser pull loop must not risk an unsent editor draft during reset adoption',
    );
    assert.equal(browserPull?.reset, true);
    assert.equal(browserPull?.cursor, 3);
    assert.equal(browserPull?.epoch, rotatedEpoch);
    assert.equal(localStorage.getItem('chronicle_sync_cursor_v2:epoch-client'), '3');
    assert.equal(
      localStorage.getItem('chronicle_sync_epoch_v2:epoch-client'),
      rotatedEpoch,
    );
    resetSyncCursor();
    assert.equal(localStorage.getItem('chronicle_sync_cursor_v2:epoch-client'), null);
    assert.equal(localStorage.getItem('chronicle_sync_epoch_v2:epoch-client'), null);
  } finally {
    globalThis.fetch = originalFetch;
    dom.window.close();
  }

  console.log('PASS /api/sync and /api/sync/v2 route contracts');
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  storage.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
