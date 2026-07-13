import { assert, eventually, runSuite } from '../lib/harness.mjs';
import { expectStatus, request, userIdentity, waitReady } from '../lib/api.mjs';
import { closeConnection, connectDocument } from '../lib/collab.mjs';
import { waitObject } from '../lib/s3.mjs';

let aliceId;

function portable(userId, suffix) {
  return `v1/users/${encodeURIComponent(userId)}/${suffix}`;
}

export async function run() {
  await runSuite('formal-restart-durability', async (test) => {
    test('Chronicle returns to healthy readiness after container restart', async () => {
      const ready = await waitReady(
        (body) => body.replica?.state === 'healthy' && body.replica.pending === 0,
        'restarted Chronicle readiness',
      );
      assert.equal(ready.replica.deadLetters, 0);
      aliceId = (await userIdentity('alice')).id;
    });

    test('forward identity mapping is stable across process restart', async () => {
      const again = await userIdentity('alice');
      assert.equal(again.id, aliceId);
      assert.equal(again.display_name, 'Formal alice');
    });

    test('ordinary manuscript and chapter survive restart', async () => {
      const result = await expectStatus('/api/manuscripts/formal_durable', 200, { user: 'alice' });
      assert.equal(result.data.metadata.title, 'Durable Book');
      assert.equal(result.data.chapters[0].id, 'collab');
      assert.match(result.data.chapters[0].content, /Initial collaborative prose/);
    });

    test('outage-created manuscript survives restart', async () => {
      const result = await expectStatus('/api/manuscripts/formal_outage', 200, { user: 'alice' });
      assert.equal(result.data.chapters[0].content, '<p>SQLite remains authoritative ✓</p>');
    });

    test('replicated settings and local settings survive restart identically', async () => {
      const local = await expectStatus('/api/settings', 200, { user: 'alice' });
      const remote = await waitObject(portable(aliceId, 'settings.json'));
      assert.deepEqual(local.data.settings, JSON.parse(remote.bytes.toString('utf8')));
    });

    test('retained tombstones prevent deleted manuscript resurrection after restart', async () => {
      await expectStatus('/api/manuscripts/formal_unicode', 404, { user: 'alice' });
      const recreate = await expectStatus('/api/manuscripts', 409, {
        user: 'alice',
        json: {
          metadata: { id: 'formal_unicode', title: 'resurrection', author: 'bad', lastModified: Date.now() + 99_000_000 },
          chapters: [],
        },
      });
      assert.ok(recreate.data.conflicts.some((conflict) => conflict.reason === 'deleted'));
    });

    test('Yjs collaboration state survives restart and reconnect', async () => {
      const name = `${encodeURIComponent(aliceId)}/formal_durable:collab`;
      const connection = await connectDocument({ user: 'alice', documentName: name });
      try {
        await eventually(
          () => connection.document.getMap('formal').get('durability-proof') === 'converged-東京-✓',
          { timeoutMs: 10_000, label: 'restarted Yjs state' },
        );
        assert.equal(connection.document.getMap('formal').get('durability-proof'), 'converged-東京-✓');
      } finally {
        closeConnection(connection);
      }
    });

    test('S3 portable record remains available after Chronicle restart', async () => {
      const object = await waitObject(portable(aliceId, 'manuscripts/formal_outage/metadata.json'));
      assert.equal(JSON.parse(object.bytes.toString('utf8')).metadata.title, 'Written during outage');
    });

    test('library remains user isolated after restart', async () => {
      const bob = await expectStatus('/api/manuscripts', 200, { user: 'bob' });
      assert.equal(bob.data.some((entry) => entry.id === 'formal_durable'), false);
      const alice = await request('/api/manuscripts', { user: 'alice' });
      assert.equal(alice.data.some((entry) => entry.id === 'formal_durable'), true);
    });
  });
}
