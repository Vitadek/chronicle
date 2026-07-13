import fs from 'node:fs/promises';
import { assert, runSuite } from '../lib/harness.mjs';
import {
  expectStatus,
  request,
  userIdentity,
  waitReady,
} from '../lib/api.mjs';
import {
  assertChronicleMetadata,
  waitObject,
} from '../lib/s3.mjs';
import { expectDenied } from '../lib/collab.mjs';

let baseline;
let postV2;
let durable;

function portable(userId, suffix) {
  return `v1/users/${encodeURIComponent(userId)}/${suffix}`;
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

function expectedAdvancedRevisions() {
  return baseline.replicaAuthoritativeRevisions.map((replicaRecord) => {
    const localRecord = baseline.authoritativeRevisions.find((candidate) =>
      candidate.entity === replicaRecord.entity &&
      candidate.id === replicaRecord.id &&
      candidate.manuscriptId === replicaRecord.manuscriptId);
    assert.ok(localRecord, `missing pre-apply revision for ${replicaRecord.entity}:${replicaRecord.id}`);
    return { ...replicaRecord, revision: Math.max(replicaRecord.revision, localRecord.revision) + 1 };
  });
}

function chapterMetadata(bytes) {
  const encoded = /data-chronicle-record="([A-Za-z0-9_-]+)"/.exec(bytes.toString('utf8'))?.[1];
  assert.ok(encoded, 'portable chapter metadata marker must exist');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

export async function run() {
  await runSuite('formal-offline-restore', async (test) => {
    test('Chronicle restarts healthy with the same forward identity', async () => {
      baseline = JSON.parse(await fs.readFile('/artifacts/restore-baseline.json', 'utf8'));
      const ready = await waitReady((body) => body.ready && body.database === 'ready');
      assert.equal(ready.replica.provider, 's3');
      assert.equal((await userIdentity('alice')).id, baseline.aliceId);
    });

    test('live manuscript and chapter data survive the offline restore', async () => {
      const [durableResult, outage] = await Promise.all([
        expectStatus('/api/manuscripts/formal_durable', 200, { user: 'alice' }),
        expectStatus('/api/manuscripts/formal_outage', 200, { user: 'alice' }),
      ]);
      durable = durableResult.data;
      assert.equal(durable.metadata.title, baseline.records.durable.title);
      assert.equal(durable.chapters[0].content, baseline.records.durable.chapterContent);
      assert.equal(outage.data.metadata.title, baseline.records.outage.title);
      assert.equal(outage.data.chapters[0].content, baseline.records.outage.chapterContent);
    });

    test('settings and opaque cover bytes survive the offline restore', async () => {
      const [settings, cover] = await Promise.all([
        expectStatus('/api/settings', 200, { user: 'alice' }),
        expectStatus(`/api/covers/${baseline.cover.filename}`, 200, { user: 'alice' }),
      ]);
      assert.deepEqual(settings.data.settings, baseline.settings);
      assert.equal(cover.bytes.toString('hex'), baseline.cover.hex);
    });

    test('every restored Alice record advances exactly one authoritative revision', async () => {
      const result = await expectStatus('/api/sync/v2', 200, {
        user: 'alice',
        json: { cursor: 0, changes: [] },
      });
      postV2 = result.data;
      assert.equal(postV2.hasMore, false);
      assert.notEqual(postV2.epoch, baseline.v2.epoch);
      assert.deepEqual(revisionProjection(postV2.changes), expectedAdvancedRevisions());
      assert.equal(durable.metadata.revision, baseline.preApply.durable.manuscriptRevision + 1);
      assert.equal(durable.chapters[0].revision, baseline.preApply.durable.chapterRevision + 1);
    });

    test('retained manuscript and chapter tombstones remain terminal and scrubbed', async () => {
      await expectStatus('/api/manuscripts/formal_unicode', 404, { user: 'alice' });
      await expectStatus(`/api/manuscripts/${baseline.records.deleted.manuscriptId}`, 404, { user: 'alice' });
      const recreate = await expectStatus(
        `/api/manuscripts/${baseline.records.deleted.manuscriptId}`,
        404,
        { user: 'alice' },
      );
      assert.equal(recreate.data.error, 'Manuscript not found');
      const deletedManuscript = findChange(
        postV2.changes,
        'manuscript',
        baseline.records.deleted.manuscriptId,
      );
      const deletedChapter = findChange(
        postV2.changes,
        'chapter',
        baseline.records.deleted.chapterId,
        baseline.records.deleted.manuscriptId,
      );
      assert.equal(deletedManuscript.operation, 'delete');
      assert.equal(deletedChapter.operation, 'delete');
      assert.equal(deletedManuscript.revision, baseline.records.deleted.manuscriptRevision + 1);
      assert.equal(deletedChapter.revision, baseline.records.deleted.chapterRevision + 1);
    });

    test('a nonempty push carrying the old epoch resets without mutating state', async () => {
      const before = await expectStatus('/api/manuscripts/formal_durable', 200, { user: 'alice' });
      const attemptedTitle = 'MUST NOT COMMIT stale restore epoch';
      const stale = await expectStatus('/api/sync/v2', 200, {
        user: 'alice',
        json: {
          epoch: baseline.v2.epoch,
          cursor: baseline.v2.cursor,
          changes: [{
            entity: 'manuscript',
            operation: 'upsert',
            id: 'formal_durable',
            baseRevision: before.data.metadata.revision,
            data: JSON.stringify({
              id: 'formal_durable',
              title: attemptedTitle,
              author: 'stale client',
              lastModified: Date.now(),
            }),
          }],
        },
      });
      assert.equal(stale.data.reset, true);
      assert.equal(stale.data.epoch, postV2.epoch);
      assert.notEqual(stale.data.epoch, baseline.v2.epoch);
      assert.equal(stale.data.results.length, 1);
      assert.equal(stale.data.results[0].status, 'conflict');
      assert.equal(stale.data.results[0].reason, 'history_epoch_mismatch');
      assert.equal(stale.data.results[0].revision, before.data.metadata.revision);
      const after = await expectStatus('/api/manuscripts/formal_durable', 200, { user: 'alice' });
      assert.equal(after.data.metadata.title, before.data.metadata.title);
      assert.equal(after.data.metadata.revision, before.data.metadata.revision);
      assert.equal(JSON.stringify(after.data).includes(attemptedTitle), false);
      postV2.resetReplay = stale.data.changes;
    });

    test('the epoch-reset response replays live, profile, and tombstone state', async () => {
      const replay = postV2.resetReplay;
      assert.equal(findChange(replay, 'manuscript', 'formal_durable')?.operation, 'upsert');
      assert.equal(findChange(replay, 'profile', 'profile')?.operation, 'upsert');
      assert.equal(
        findChange(replay, 'manuscript', baseline.records.deleted.manuscriptId)?.operation,
        'delete',
      );
      assert.equal(
        findChange(
          replay,
          'chapter',
          baseline.records.deleted.chapterId,
          baseline.records.deleted.manuscriptId,
        )?.operation,
        'delete',
      );
    });

    test('legacy sync since the pre-restore cursor sees manuscript, chapter, and profile', async () => {
      const result = await expectStatus('/api/sync', 200, {
        user: 'alice',
        json: { since: baseline.legacySince },
      });
      const manuscript = result.data.pull.manuscripts.find((item) => item.id === 'formal_durable');
      const chapter = result.data.pull.chapters.find((item) =>
        item.manuscript_id === 'formal_durable' && item.id === baseline.records.durable.chapterId);
      assert.ok(manuscript);
      assert.ok(chapter);
      assert.ok(result.data.pull.profile);
      assert.ok(manuscript.last_modified > baseline.legacySince);
      assert.ok(chapter.last_modified > baseline.legacySince);
      assert.ok(result.data.pull.profile.last_modified > baseline.legacySince);
      assert.equal(JSON.parse(manuscript.data).title, baseline.records.durable.title);
      assert.equal(chapter.content, baseline.records.durable.chapterContent);
      assert.deepEqual(JSON.parse(result.data.pull.profile.data), baseline.expectedProfile);
    });

    test('deleted collaboration state cannot leak or resurrect after restore', async () => {
      assert.equal(await expectDenied({
        user: 'alice',
        documentName: baseline.collaboration.documentName,
      }), true);
      const metadata = await waitObject(portable(
        baseline.aliceId,
        `manuscripts/${baseline.records.deleted.manuscriptId}/metadata.json`,
      ));
      const chapter = await waitObject(portable(
        baseline.aliceId,
        `manuscripts/${baseline.records.deleted.manuscriptId}/chapters/${baseline.records.deleted.chapterId}.html`,
      ));
      assert.equal(metadata.bytes.includes(Buffer.from(baseline.collaboration.secret)), false);
      assert.equal(chapter.bytes.includes(Buffer.from(baseline.collaboration.secret)), false);
      assert.equal(JSON.parse(metadata.bytes.toString('utf8')).kind, 'manuscript-tombstone');
      assert.equal(chapterMetadata(chapter.bytes).kind, 'chapter-tombstone');
      assert.equal(chapterMetadata(chapter.bytes).contentBytes, 0);
    });

    test('real MinIO converges to the advanced restored revisions', async () => {
      const metadataKey = portable(baseline.aliceId, 'manuscripts/formal_durable/metadata.json');
      const chapterKey = portable(
        baseline.aliceId,
        `manuscripts/formal_durable/chapters/${baseline.records.durable.chapterId}.html`,
      );
      const profileKey = portable(baseline.aliceId, 'profile.json');
      const [metadata, chapter, profile] = await Promise.all([
        waitObject(metadataKey, (object) => {
          try { return JSON.parse(object.bytes.toString('utf8')).revision === baseline.preApply.durable.manuscriptRevision + 1; }
          catch { return false; }
        }),
        waitObject(chapterKey, (object) => {
          try { return chapterMetadata(object.bytes).revision === baseline.preApply.durable.chapterRevision + 1; }
          catch { return false; }
        }),
        waitObject(profileKey, (object) => {
          try {
            const expected = baseline.authoritativeRevisions.find((item) =>
              item.entity === 'profile' && item.id === 'profile').revision + 1;
            return JSON.parse(object.bytes.toString('utf8')).revision === expected;
          }
          catch { return false; }
        }),
      ]);
      assertChronicleMetadata(assert, metadata);
      assertChronicleMetadata(assert, chapter);
      assertChronicleMetadata(assert, profile);
    });

    test('the post-restore replica fully drains without dead letters', async () => {
      const ready = await waitReady(
        (body) => body.replica?.state === 'healthy' &&
          body.replica.pending === 0 && body.replica.deadLetters === 0,
        'post-restore drained replica',
      );
      assert.equal(ready.database, 'ready');
      assert.equal(ready.replica.initialized, true);
    });

    test('restored data remains isolated from another authenticated user', async () => {
      const bob = await expectStatus('/api/manuscripts', 200, { user: 'bob' });
      assert.equal(bob.data.some((item) => item.id === 'formal_durable'), false);
      await expectStatus('/api/manuscripts/formal_durable', 404, { user: 'bob' });
    });
  });
}
