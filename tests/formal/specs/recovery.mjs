import { assert, runSuite } from '../lib/harness.mjs';
import { expectStatus, request, userIdentity, waitReady } from '../lib/api.mjs';
import { assertChronicleMetadata, waitObject } from '../lib/s3.mjs';

let aliceId;

function portable(userId, suffix) {
  return `v1/users/${encodeURIComponent(userId)}/${suffix}`;
}

function chapterMetadata(bytes) {
  const encoded = /data-chronicle-record="([A-Za-z0-9_-]+)"/.exec(bytes.toString('utf8'))?.[1];
  assert.ok(encoded);
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

export async function run() {
  await runSuite('formal-s3-recovery', async (test) => {
    test('host CLI retry drains dead letters and restores healthy readiness', async () => {
      aliceId = (await userIdentity('alice')).id;
      const ready = await waitReady(
        (body) => body.replica?.state === 'healthy' && body.replica.pending === 0 && body.replica.deadLetters === 0,
        'post-retry healthy replica',
      );
      assert.equal(ready.database, 'ready');
      assert.equal(ready.replica.initialized, true);
    });

    test('outage-created manuscript arrives at the exact portable S3 key', async () => {
      const key = portable(aliceId, 'manuscripts/formal_outage/metadata.json');
      const object = await waitObject(key);
      const record = JSON.parse(object.bytes.toString('utf8'));
      assert.equal(record.kind, 'manuscript');
      assert.equal(record.metadata.title, 'Written during outage');
      assert.equal(record.userId, aliceId);
      assertChronicleMetadata(assert, object);
    });

    test('outage-created chapter arrives with its exact prose and metadata', async () => {
      const key = portable(aliceId, 'manuscripts/formal_outage/chapters/offline.html');
      const object = await waitObject(key);
      assert.match(object.bytes.toString('utf8'), /SQLite remains authoritative/);
      assert.equal(chapterMetadata(object.bytes).kind, 'chapter');
      assertChronicleMetadata(assert, object);
    });

    test('latest settings overwrite is replicated after retry', async () => {
      const key = portable(aliceId, 'settings.json');
      const object = await waitObject(key, (candidate) => {
        try { return JSON.parse(candidate.bytes.toString('utf8')).outage === 'persisted-locally'; } catch { return false; }
      });
      assert.deepEqual(JSON.parse(object.bytes.toString('utf8')), {
        outage: 'persisted-locally', phase: 'formal',
      });
      assertChronicleMetadata(assert, object);
    });

    test('SQLite data is unchanged by remote recovery', async () => {
      const result = await expectStatus('/api/manuscripts/formal_outage', 200, { user: 'alice' });
      assert.equal(result.data.chapters[0].content, '<p>SQLite remains authoritative ✓</p>');
      const settings = await expectStatus('/api/settings', 200, { user: 'alice' });
      assert.equal(settings.data.settings.phase, 'formal');
    });

    test('readiness stays sanitized after recovery', async () => {
      const result = await request('/readyz');
      assert.equal(result.status, 200);
      assert.equal(Object.hasOwn(result.data.replica, 'lastError'), false);
      assert.equal(JSON.stringify(result.data).includes('chronicle-formal-secret'), false);
    });
  });
}
