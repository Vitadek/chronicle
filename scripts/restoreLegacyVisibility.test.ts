import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-restore-legacy-'));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_REPLICA = 'none';
process.env.NODE_ENV = 'test';

const { db, LOCAL_USER_ID } = await import('../server/db');
const { default: syncRouter } = await import('../server/routes/sync');
const {
  parsePortableChapter,
  serializePortableChapter,
} = await import('../server/lib/portableReplica');
const { applyRestorePlan } = await import('../server/lib/restoreApply');
const { storage } = await import('../server/lib/storage/HybridManager');

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
  const portableTimestamp = 1_000;
  db.prepare(`
    INSERT INTO manuscripts(user_id, id, data, last_modified, deleted_at, revision)
    VALUES (?, 'visibility-book', ?, 2_000, NULL, 7)
  `).run(
    LOCAL_USER_ID,
    JSON.stringify({ id: 'visibility-book', title: 'local newer than backup' }),
  );
  db.prepare(`
    INSERT INTO chapters(
      user_id, manuscript_id, id, title, content, position,
      last_modified, deleted_at, revision
    ) VALUES (
      ?, 'visibility-book', 'visibility-chapter',
      'Local chapter', '<p>local newer than backup</p>', 0, 2_000, NULL, 8
    )
  `).run(LOCAL_USER_ID);
  db.prepare(`
    INSERT INTO profiles(user_id, data, last_modified, revision)
    VALUES (?, '{"displayName":"local newer than backup"}', 2_000, 9)
  `).run(LOCAL_USER_ID);

  // This is a serverTime cursor a legacy client could have learned after the
  // portable snapshot was written but immediately before the forced restore.
  const legacySince = Date.now();
  const restoredChapter = parsePortableChapter(serializePortableChapter({
    userId: LOCAL_USER_ID,
    manuscriptId: 'visibility-book',
    id: 'visibility-chapter',
    title: 'Restored chapter',
    position: 0,
    revision: 3,
    lastModified: portableTimestamp,
  }, '<p>restored chapter state</p>'));

  applyRestorePlan({
    manuscripts: [{
      record: {
        schemaVersion: 1,
        kind: 'manuscript',
        userId: LOCAL_USER_ID,
        id: 'visibility-book',
        revision: 4,
        lastModified: portableTimestamp,
        metadata: {
          id: 'visibility-book',
          title: 'Restored manuscript',
          author: 'Restore test',
          lastModified: portableTimestamp,
        },
      },
    }],
    chapters: [{ record: restoredChapter }],
    profiles: [{
      record: {
        schemaVersion: 1,
        kind: 'profile',
        userId: LOCAL_USER_ID,
        revision: 5,
        lastModified: portableTimestamp,
        profile: { displayName: 'restored profile state' },
      },
    }],
    blobs: [],
  });

  const storedTimes = db.prepare(`
    SELECT
      (SELECT last_modified FROM manuscripts
        WHERE user_id = ? AND id = 'visibility-book') AS manuscript_time,
      (SELECT revision FROM manuscripts
        WHERE user_id = ? AND id = 'visibility-book') AS manuscript_revision,
      (SELECT last_modified FROM chapters
        WHERE user_id = ? AND manuscript_id = 'visibility-book'
          AND id = 'visibility-chapter') AS chapter_time,
      (SELECT revision FROM chapters
        WHERE user_id = ? AND manuscript_id = 'visibility-book'
          AND id = 'visibility-chapter') AS chapter_revision,
      (SELECT last_modified FROM profiles WHERE user_id = ?) AS profile_time,
      (SELECT revision FROM profiles WHERE user_id = ?) AS profile_revision
  `).get(
    LOCAL_USER_ID,
    LOCAL_USER_ID,
    LOCAL_USER_ID,
    LOCAL_USER_ID,
    LOCAL_USER_ID,
    LOCAL_USER_ID,
  ) as {
    manuscript_time: number;
    manuscript_revision: number;
    chapter_time: number;
    chapter_revision: number;
    profile_time: number;
    profile_revision: number;
  };
  assert(storedTimes.manuscript_time > legacySince);
  assert(storedTimes.chapter_time > legacySince);
  assert(storedTimes.profile_time > legacySince);
  assert.equal(storedTimes.manuscript_revision, 8);
  assert.equal(storedTimes.chapter_revision, 9);
  assert.equal(storedTimes.profile_revision, 10);

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ since: legacySince, push: {} }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as {
    pull: {
      manuscripts: Array<{
        id: string;
        data: string;
        last_modified: number;
        deleted: boolean;
      }>;
      chapters: Array<{
        id: string;
        manuscript_id: string;
        title: string;
        content: string;
        last_modified: number;
        deleted: boolean;
      }>;
      profile: { data: string; last_modified: number } | null;
    };
  };

  const manuscript = body.pull.manuscripts.find((item) => item.id === 'visibility-book');
  assert(manuscript, 'legacy pull omitted the restored manuscript');
  assert.equal(JSON.parse(manuscript.data).title, 'Restored manuscript');
  assert.equal(manuscript.deleted, false);
  assert(manuscript.last_modified > legacySince);

  const chapter = body.pull.chapters.find((item) => item.id === 'visibility-chapter');
  assert(chapter, 'legacy pull omitted the restored chapter');
  assert.equal(chapter.manuscript_id, 'visibility-book');
  assert.equal(chapter.title, 'Restored chapter');
  assert.equal(chapter.content, '<p>restored chapter state</p>');
  assert.equal(chapter.deleted, false);
  assert(chapter.last_modified > legacySince);

  assert(body.pull.profile, 'legacy pull omitted the restored profile');
  assert.equal(JSON.parse(body.pull.profile.data).displayName, 'restored profile state');
  assert(body.pull.profile.last_modified > legacySince);

  console.log('PASS forced restore is visible to legacy sync after portable timestamps');
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  storage.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
