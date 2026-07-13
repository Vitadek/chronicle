import fs from 'node:fs/promises';
import {
  assert,
  eventually,
  runSuite,
} from '../lib/harness.mjs';
import {
  expectStatus,
  manuscript,
  request,
  userIdentity,
  waitReady,
} from '../lib/api.mjs';
import {
  getObject,
  listObjects,
  waitObject,
} from '../lib/s3.mjs';
import {
  closeConnection,
  connectDocument,
  expectDenied,
} from '../lib/collab.mjs';

const alice = 'alice';
const deletedManuscriptId = 'formal_restore_deleted';
const deletedChapterId = 'secret';
const collaborationSecret = 'formal-restore-yjs-secret-東京-✓';
const expectedProfile = {
  displayName: 'Alice Restore Fixture',
  recoveryMarker: 'portable-profile-東京-✓',
};
const expectedSettings = { outage: 'persisted-locally', phase: 'formal' };
const divergentSettings = { outage: 'local-only-divergence', phase: 'must-be-restored' };
const divergentProfile = {
  displayName: 'Divergent local profile',
  recoveryMarker: 'must-not-survive-restore',
};
const divergentTitle = 'Divergent local title — must be restored';
const divergentChapterContent = '<p>local-only chapter divergence MUST NOT survive</p>';
const toxiproxy = process.env.TOXIPROXY_URL || 'http://toxiproxy:8474';

let aliceId;
let documentName;
let inventory;
let recoverySnapshot;

function portable(userId, suffix) {
  return `v1/users/${encodeURIComponent(userId)}/${suffix}`;
}

function decodeSegment(value) {
  return decodeURIComponent(value);
}

function classifyInventory(objects, userFilter) {
  const summary = {
    manuscripts: 0,
    chapters: 0,
    profiles: 0,
    blobs: 0,
    ignored: 0,
    conflicts: 0,
    conflictKeys: [],
  };
  for (const object of objects) {
    const key = object.logicalKey;
    let match = /^v1\/users\/([^/]+)\/manuscripts\/([^/]+)\/metadata\.json$/.exec(key);
    if (match) {
      const userId = decodeSegment(match[1]);
      if (userFilter && userId !== userFilter) continue;
      const id = decodeSegment(match[2]);
      summary.manuscripts += 1;
      summary.conflictKeys.push(`manuscript:${userId}/${id}`);
      continue;
    }
    match = /^v1\/users\/([^/]+)\/manuscripts\/([^/]+)\/chapters\/([^/]+)\.html$/.exec(key);
    if (match) {
      const userId = decodeSegment(match[1]);
      if (userFilter && userId !== userFilter) continue;
      const manuscriptId = decodeSegment(match[2]);
      const id = decodeSegment(match[3]);
      summary.chapters += 1;
      summary.conflictKeys.push(`chapter:${userId}/${manuscriptId}/${id}`);
      continue;
    }
    match = /^v1\/users\/([^/]+)\/profile\.json$/.exec(key);
    if (match) {
      const userId = decodeSegment(match[1]);
      if (userFilter && userId !== userFilter) continue;
      summary.profiles += 1;
      summary.conflictKeys.push(`profile:${userId}`);
      continue;
    }
    match = /^v1\/users\/([^/]+)\/covers\/([^/]+)$/.exec(key);
    if (match) {
      const userId = decodeSegment(match[1]);
      if (userFilter && userId !== userFilter) continue;
      const filename = decodeSegment(match[2]);
      summary.blobs += 1;
      summary.conflictKeys.push(`blob:covers/${userId}/${filename}`);
      continue;
    }
    match = /^v1\/users\/([^/]+)\/settings\.json$/.exec(key);
    if (match) {
      const userId = decodeSegment(match[1]);
      if (userFilter && userId !== userFilter) continue;
      summary.blobs += 1;
      summary.conflictKeys.push(`blob:settings/${userId}`);
      continue;
    }
    summary.ignored += 1;
  }
  summary.conflicts = summary.conflictKeys.length;
  summary.conflictKeys.sort();
  return summary;
}

function revisionProjection(changes) {
  return changes
    .map((change) => ({
      entity: change.entity,
      ...(change.manuscriptId ? { manuscriptId: change.manuscriptId } : {}),
      id: change.id,
      operation: change.operation,
      revision: change.revision,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function findChange(changes, entity, id, manuscriptId) {
  return changes.find((change) =>
    change.entity === entity &&
    change.id === id &&
    (manuscriptId === undefined || change.manuscriptId === manuscriptId));
}

function chapterMetadata(bytes) {
  const encoded = /data-chronicle-record="([A-Za-z0-9_-]+)"/.exec(bytes.toString('utf8'))?.[1];
  assert.ok(encoded, 'portable chapter metadata marker must exist');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

async function setProxy(enabled) {
  const response = await fetch(`${toxiproxy}/proxies/minio-s3`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(JSON.parse(text).enabled, enabled);
}

export async function run() {
  await runSuite('formal-pre-restore-capture', async (test) => {
    test('Alice profile is created through sync v2 and reaches real MinIO', async () => {
      aliceId = (await userIdentity(alice)).id;
      const initial = await expectStatus('/api/sync/v2', 200, {
        user: alice,
        json: { cursor: 0, changes: [] },
      });
      assert.match(initial.data.epoch, /^[0-9a-f-]{36}$/i);
      const created = await expectStatus('/api/sync/v2', 200, {
        user: alice,
        json: {
          epoch: initial.data.epoch,
          cursor: initial.data.cursor,
          changes: [{
            entity: 'profile',
            operation: 'upsert',
            baseRevision: 0,
            data: JSON.stringify(expectedProfile),
          }],
        },
      });
      assert.equal(created.data.results[0].status, 'accepted');
      assert.equal(created.data.results[0].revision, 1);
      const remote = await waitObject(portable(aliceId, 'profile.json'), (object) => {
        try {
          return JSON.parse(object.bytes.toString('utf8')).revision === 1;
        } catch {
          return false;
        }
      });
      assert.deepEqual(JSON.parse(remote.bytes.toString('utf8')).profile, expectedProfile);
    });

    test('a persisted Yjs-only secret is purged when its owning book is deleted', async () => {
      const created = await expectStatus('/api/manuscripts', 201, {
        user: alice,
        json: manuscript(deletedManuscriptId, 'Restore tombstone fixture', [{
          id: deletedChapterId,
          title: 'Secret collaborative chapter',
          content: '<p>portable prose before delete</p>',
        }]),
      });
      documentName = `${encodeURIComponent(aliceId)}/${deletedManuscriptId}:${deletedChapterId}`;
      const connection = await connectDocument({ user: alice, documentName });
      connection.document.getMap('formal').set('restore-secret', collaborationSecret);
      await eventually(
        () => connection.document.getMap('formal').get('restore-secret') === collaborationSecret,
        { label: 'local restore collaboration fixture' },
      );
      closeConnection(connection);

      const reopened = await connectDocument({ user: alice, documentName });
      try {
        await eventually(
          () => reopened.document.getMap('formal').get('restore-secret') === collaborationSecret,
          { timeoutMs: 10_000, label: 'persisted restore collaboration fixture' },
        );
      } finally {
        closeConnection(reopened);
      }

      const current = (await request(`/api/manuscripts/${deletedManuscriptId}`, { user: alice })).data;
      assert.ok(current.metadata.revision >= created.data.metadata.revision);
      await expectStatus(`/api/manuscripts/${deletedManuscriptId}`, 204, {
        user: alice,
        method: 'DELETE',
        json: { baseRevision: current.metadata.revision },
      });
      await expectStatus(`/api/manuscripts/${deletedManuscriptId}`, 404, { user: alice });
      assert.equal(await expectDenied({ user: alice, documentName }), true);

      const metadata = await waitObject(
        portable(aliceId, `manuscripts/${deletedManuscriptId}/metadata.json`),
        (object) => {
          try { return JSON.parse(object.bytes.toString('utf8')).kind === 'manuscript-tombstone'; }
          catch { return false; }
        },
      );
      const chapter = await waitObject(
        portable(aliceId, `manuscripts/${deletedManuscriptId}/chapters/${deletedChapterId}.html`),
        (object) => {
          try { return chapterMetadata(object.bytes).kind === 'chapter-tombstone'; }
          catch { return false; }
        },
      );
      assert.equal(metadata.bytes.includes(Buffer.from(collaborationSecret)), false);
      assert.equal(chapter.bytes.includes(Buffer.from(collaborationSecret)), false);
      assert.equal(chapterMetadata(chapter.bytes).contentBytes, 0);
    });

    test('replication drains before the recovery snapshot is captured', async () => {
      const ready = await waitReady(
        (body) => body.replica?.state === 'healthy' &&
          body.replica.pending === 0 && body.replica.deadLetters === 0,
        'pre-restore drained replica',
      );
      assert.equal(ready.replica.provider, 's3');
      inventory = await listObjects();
      assert.ok(inventory.length > 0);
    });

    test('real MinIO inventory has the exact all-user restore plan', async () => {
      const actual = classifyInventory(inventory);
      assert.deepEqual(
        {
          manuscripts: actual.manuscripts,
          chapters: actual.chapters,
          profiles: actual.profiles,
          blobs: actual.blobs,
          ignored: actual.ignored,
          conflicts: actual.conflicts,
        },
        { manuscripts: 7, chapters: 7, profiles: 2, blobs: 2, ignored: 0, conflicts: 18 },
      );
    });

    test('real MinIO inventory has the exact Alice-filtered restore plan', async () => {
      const actual = classifyInventory(inventory, aliceId);
      assert.deepEqual(
        {
          manuscripts: actual.manuscripts,
          chapters: actual.chapters,
          profiles: actual.profiles,
          blobs: actual.blobs,
          ignored: actual.ignored,
          conflicts: actual.conflicts,
        },
        { manuscripts: 6, chapters: 7, profiles: 1, blobs: 2, ignored: 0, conflicts: 16 },
      );
    });

    test('the drained remote recovery snapshot is captured before local divergence', async () => {
      const [durable, outage, settings, v2] = await Promise.all([
        expectStatus('/api/manuscripts/formal_durable', 200, { user: alice }),
        expectStatus('/api/manuscripts/formal_outage', 200, { user: alice }),
        expectStatus('/api/settings', 200, { user: alice }),
        expectStatus('/api/sync/v2', 200, { user: alice, json: { cursor: 0, changes: [] } }),
      ]);
      assert.equal(v2.data.hasMore, false);
      assert.deepEqual(settings.data.settings, expectedSettings);
      const profile = findChange(v2.data.changes, 'profile', 'profile');
      const deletedManuscript = findChange(v2.data.changes, 'manuscript', deletedManuscriptId);
      const deletedChapter = findChange(
        v2.data.changes,
        'chapter',
        deletedChapterId,
        deletedManuscriptId,
      );
      assert.equal(profile?.revision, 1);
      assert.equal(JSON.parse(profile.data).recoveryMarker, expectedProfile.recoveryMarker);
      assert.equal(deletedManuscript?.operation, 'delete');
      assert.equal(deletedChapter?.operation, 'delete');

      const coverKey = inventory.find((object) =>
        object.logicalKey.startsWith(portable(aliceId, 'covers/formal_durable.')))?.logicalKey;
      assert.ok(coverKey, 'durable cover object must be present in MinIO');
      const cover = await getObject(coverKey);
      recoverySnapshot = {
        replicaAuthoritativeRevisions: revisionProjection(v2.data.changes),
        expectedProfile,
        settings: settings.data.settings,
        cover: {
          logicalKey: coverKey,
          filename: coverKey.split('/').at(-1),
          hex: cover.bytes.toString('hex'),
        },
        records: {
          durable: {
            title: durable.data.metadata.title,
            manuscriptRevision: durable.data.metadata.revision,
            chapterId: durable.data.chapters[0].id,
            chapterRevision: durable.data.chapters[0].revision,
            chapterContent: durable.data.chapters[0].content,
          },
          outage: {
            title: outage.data.metadata.title,
            manuscriptRevision: outage.data.metadata.revision,
            chapterId: outage.data.chapters[0].id,
            chapterRevision: outage.data.chapters[0].revision,
            chapterContent: outage.data.chapters[0].content,
          },
          deleted: {
            manuscriptId: deletedManuscriptId,
            manuscriptRevision: deletedManuscript.revision,
            chapterId: deletedChapterId,
            chapterRevision: deletedChapter.revision,
          },
        },
      };
    });

    test('writes diverge locally while the captured MinIO snapshot stays offline', async () => {
      await setProxy(false);

      const durable = (await request('/api/manuscripts/formal_durable', { user: alice })).data;
      durable.metadata.title = divergentTitle;
      durable.metadata.lastModified = Date.now();
      durable.chapters[0].content = divergentChapterContent;
      durable.chapters[0].lastModified = Date.now();
      const changedDurable = await expectStatus('/api/manuscripts/formal_durable', 200, {
        user: alice,
        method: 'PUT',
        json: durable,
      });
      assert.equal(changedDurable.data.metadata.title, divergentTitle);
      assert.equal(changedDurable.data.chapters[0].content, divergentChapterContent);

      await expectStatus('/api/settings', 200, {
        user: alice,
        method: 'PUT',
        json: { settings: divergentSettings },
      });

      const sync = await expectStatus('/api/sync/v2', 200, {
        user: alice,
        json: { cursor: 0, changes: [] },
      });
      const profile = findChange(sync.data.changes, 'profile', 'profile');
      const changedProfile = await expectStatus('/api/sync/v2', 200, {
        user: alice,
        json: {
          epoch: sync.data.epoch,
          cursor: sync.data.cursor,
          changes: [{
            entity: 'profile',
            operation: 'upsert',
            baseRevision: profile.revision,
            data: JSON.stringify(divergentProfile),
          }],
        },
      });
      assert.equal(changedProfile.data.results[0].status, 'accepted');

      await expectStatus('/api/covers/formal_durable', 200, {
        user: alice,
        method: 'DELETE',
      });
      await expectStatus(`/api/covers/${recoverySnapshot.cover.filename}`, 404, { user: alice });

      const outage = (await request('/api/manuscripts/formal_outage', { user: alice })).data;
      await expectStatus('/api/manuscripts/formal_outage', 204, {
        user: alice,
        method: 'DELETE',
        json: { baseRevision: outage.metadata.revision },
      });
      await expectStatus('/api/manuscripts/formal_outage', 404, { user: alice });
    });

    test('all divergent jobs dead-letter before Chronicle is stopped', async () => {
      const ready = await waitReady(
        (body) => body.replica?.state === 'degraded' &&
          body.replica.pending === 7 && body.replica.deadLetters === 7,
        'seven divergent dead-letter jobs',
      );
      assert.equal(ready.replica.pending, 7);

      const [durable, settings, v2, legacy] = await Promise.all([
        expectStatus('/api/manuscripts/formal_durable', 200, { user: alice }),
        expectStatus('/api/settings', 200, { user: alice }),
        expectStatus('/api/sync/v2', 200, { user: alice, json: { cursor: 0, changes: [] } }),
        expectStatus('/api/sync', 200, { user: alice, json: { since: 0 } }),
      ]);
      assert.equal(v2.data.hasMore, false);
      assert.equal(durable.data.metadata.title, divergentTitle);
      assert.equal(durable.data.chapters[0].content, divergentChapterContent);
      assert.deepEqual(settings.data.settings, divergentSettings);
      const profile = findChange(v2.data.changes, 'profile', 'profile');
      const outageManuscript = findChange(v2.data.changes, 'manuscript', 'formal_outage');
      const outageChapter = findChange(v2.data.changes, 'chapter', 'offline', 'formal_outage');
      assert.deepEqual(JSON.parse(profile.data), divergentProfile);
      assert.equal(outageManuscript.operation, 'delete');
      assert.equal(outageChapter.operation, 'delete');

      const allRestore = classifyInventory(inventory);
      const aliceRestore = classifyInventory(inventory, aliceId);
      const remoteCoverConflict = `blob:covers/${aliceId}/${recoverySnapshot.cover.filename}`;
      for (const restore of [allRestore, aliceRestore]) {
        restore.conflictKeys = restore.conflictKeys.filter((key) => key !== remoteCoverConflict);
        restore.conflicts = restore.conflictKeys.length;
      }
      assert.equal(allRestore.conflicts, 17);
      assert.equal(aliceRestore.conflicts, 15);

      const baseline = {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        aliceId,
        legacySince: legacy.data.serverTime,
        v2: { epoch: v2.data.epoch, cursor: v2.data.cursor },
        ...recoverySnapshot,
        authoritativeRevisions: revisionProjection(v2.data.changes),
        preApply: {
          authoritativeRevisions: revisionProjection(v2.data.changes),
          settings: settings.data.settings,
          profile: divergentProfile,
          durable: {
            title: durable.data.metadata.title,
            manuscriptRevision: durable.data.metadata.revision,
            chapterRevision: durable.data.chapters[0].revision,
            chapterContent: durable.data.chapters[0].content,
          },
          outage: {
            manuscriptRevision: outageManuscript.revision,
            chapterRevision: outageChapter.revision,
          },
          cover: {
            deletedFilename: recoverySnapshot.cover.filename,
          },
          deadLetters: 7,
        },
        collaboration: { documentName, secret: collaborationSecret },
        restore: { all: allRestore, alice: aliceRestore },
      };
      await fs.writeFile('/artifacts/restore-baseline.json', `${JSON.stringify(baseline, null, 2)}\n`);
    });
  });
}
