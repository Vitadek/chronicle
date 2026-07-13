import { assert, eventually, runSuite } from '../lib/harness.mjs';
import {
  expectStatus,
  manuscript,
  request,
  userIdentity,
  waitReady,
} from '../lib/api.mjs';
import { headObject } from '../lib/s3.mjs';

const toxiproxy = process.env.TOXIPROXY_URL || 'http://toxiproxy:8474';
let aliceId;

function portable(userId, suffix) {
  return `v1/users/${encodeURIComponent(userId)}/${suffix}`;
}

async function setProxy(enabled) {
  const response = await fetch(`${toxiproxy}/proxies/minio-s3`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.enabled, enabled);
}

export async function run() {
  await runSuite('formal-s3-outage', async (test) => {
    test('Toxiproxy can cut Chronicle off from MinIO deterministically', async () => {
      aliceId = (await userIdentity('alice')).id;
      await setProxy(false);
      const response = await fetch(`${toxiproxy}/proxies/minio-s3`);
      const proxy = await response.json();
      assert.equal(proxy.enabled, false);
    });

    test('SQLite-authoritative manuscript writes succeed while S3 is offline', async () => {
      const result = await expectStatus('/api/manuscripts', 201, {
        user: 'alice',
        json: manuscript('formal_outage', 'Written during outage', [
          { id: 'offline', title: 'Offline chapter', content: '<p>SQLite remains authoritative ✓</p>' },
        ]),
      });
      assert.equal(result.data.metadata.id, 'formal_outage');
      assert.equal(result.data.chapters[0].content, '<p>SQLite remains authoritative ✓</p>');
    });

    test('SQLite-authoritative settings writes also succeed while S3 is offline', async () => {
      await expectStatus('/api/settings', 200, {
        user: 'alice',
        method: 'PUT',
        json: { settings: { outage: 'persisted-locally', phase: 'formal' } },
      });
      const result = await expectStatus('/api/settings', 200, { user: 'alice' });
      assert.deepEqual(result.data.settings, { outage: 'persisted-locally', phase: 'formal' });
    });

    test('local reads remain available during replica failure', async () => {
      const manuscriptResult = await expectStatus('/api/manuscripts/formal_outage', 200, { user: 'alice' });
      assert.equal(manuscriptResult.data.metadata.title, 'Written during outage');
      const health = await expectStatus('/healthz', 200);
      assert.equal(health.data.ok, true);
    });

    test('readiness is degraded but remains HTTP 200 because SQLite can write', async () => {
      const ready = await waitReady(
        (body) => body.ready === true && body.replica?.state === 'degraded',
        'degraded replica readiness',
      );
      assert.equal(ready.database, 'ready');
      assert.equal(ready.replica.provider, 's3');
      assert.equal(Object.hasOwn(ready.replica, 'lastError'), false);
    });

    test('bounded retries transition failed replica work to dead letters', async () => {
      const ready = await eventually(async () => {
        const result = await request('/readyz');
        const replica = result.data?.replica;
        return replica?.deadLetters > 0 && replica.pending === replica.deadLetters
          ? result.data
          : false;
      }, { timeoutMs: 20_000, intervalMs: 200, label: 'S3 dead letters' });
      assert.equal(ready.replica.pending, ready.replica.deadLetters);
      assert.ok(ready.replica.deadLetters >= 1);
    });

    test('outage-created portable metadata is absent from MinIO before recovery', async () => {
      const key = portable(aliceId, 'manuscripts/formal_outage/metadata.json');
      assert.equal(await headObject(key), null);
    });

    test('outage-created chapter object is absent from MinIO before recovery', async () => {
      const key = portable(aliceId, 'manuscripts/formal_outage/chapters/offline.html');
      assert.equal(await headObject(key), null);
    });

    test('outage-created settings replace only local authoritative state initially', async () => {
      const key = portable(aliceId, 'settings.json');
      const response = await fetch(`${process.env.S3_ENDPOINT}/chronicle-formal/${process.env.S3_PREFIX}/${key}`);
      assert.notEqual(response.status, 200, 'anonymous MinIO access must remain disabled');
      const local = await expectStatus('/api/settings', 200, { user: 'alice' });
      assert.equal(local.data.settings.outage, 'persisted-locally');
    });
  });
}
