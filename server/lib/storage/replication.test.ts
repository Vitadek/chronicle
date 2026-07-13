import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReplicaProvider } from './types';

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-storage-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_REPLICA = 'none';
  delete process.env.STORAGE_PROVIDER;

  const { db } = await import('../../db');
  const { sha256 } = await import('./schema');
  const legacySettings = Buffer.from('{"theme":"dark"}', 'utf8');
  db.prepare('INSERT INTO kv(k, v) VALUES (?, ?)').run(
    'settings/local',
    legacySettings.toString('base64'),
  );
  db.prepare('INSERT INTO kv(k, v) VALUES (?, ?)').run(
    'manuscripts/local/legacy/manuscript.json',
    '{"id":"legacy"}',
  );

  const { HybridStorageManager, storage } = await import('./HybridManager');
  assert.deepEqual(await storage.get('settings/local'), legacySettings);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM kv WHERE k = ?').get('settings/local') as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare(`
      SELECT key FROM storage_replica_manifest WHERE key = ?
    `).get('v1/users/local/settings.json') as { key: string }).key,
    'v1/users/local/settings.json',
  );

  const remoteObjects = new Map<string, {
    content: Buffer;
    checksum: string;
    generation: number;
  }>();
  let remoteGets = 0;
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
  const raceCalls: Array<{ content: string; generation: number }> = [];

  const fakeReplica: ReplicaProvider = {
    name: 's3',
    initialize: async () => undefined,
    put: async (key, content, options) => {
      if (key === 'v1/users/local/manuscripts/race/metadata.json') {
        raceCalls.push({ content: content.toString('utf8'), generation: options.generation });
        if (raceCalls.length === 1) {
          announceFirst();
          await firstGate;
        }
      }
      remoteObjects.set(key, {
        content: Buffer.from(content),
        checksum: options.checksum,
        generation: options.generation,
      });
    },
    head: async (key) => {
      const value = remoteObjects.get(key);
      return value ? { key, checksum: value.checksum, generation: value.generation } : null;
    },
    get: async (key) => {
      remoteGets += 1;
      return remoteObjects.get(key)?.content || null;
    },
    delete: async (key) => { remoteObjects.delete(key); },
    list: async (prefix) => [...remoteObjects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key })),
  };

  const manager = new HybridStorageManager();
  (manager as unknown as { remote: ReplicaProvider | null }).remote = fakeReplica;
  await manager.initializeReplica();

  // A migrated legacy blob cannot overwrite a newer portable snapshot that
  // maps to the same remote key during a later local-blob bootstrap.
  const legacyReplicaKey = 'v1/users/local/manuscripts/legacy/metadata.json';
  const portableMutation = manager.enqueueReplicaPut(
    legacyReplicaKey,
    'portable-v2',
    'application/json',
  );
  assert.equal(portableMutation.generation, 2);

  const generationBeforeSeed = db.prepare(`
    SELECT generation FROM storage_replica_generations WHERE key = 'settings/local'
  `).pluck().get();
  assert.equal(manager.seedLocalBlobs(), 2);
  const seeded = db.prepare(`
    SELECT key, generation FROM storage_replication_outbox
    WHERE key = 'v1/users/local/settings.json'
  `).get() as { key: string; generation: number };
  assert.equal(seeded.generation, generationBeforeSeed);
  assert.equal(
    db.prepare(`
      SELECT generation FROM storage_replica_generations WHERE key = 'settings/local'
    `).pluck().get(),
    generationBeforeSeed,
  );
  const preserved = db.prepare(`
    SELECT CAST(payload AS TEXT) AS payload, generation
    FROM storage_replica_manifest WHERE key = ?
  `).get(legacyReplicaKey) as { payload: string; generation: number };
  assert.deepEqual(preserved, { payload: 'portable-v2', generation: 2 });
  await manager.processDue();

  // Restore tooling can update a local blob inside its larger atomic DB unit.
  assert.throws(() => db.transaction(() => {
    manager.restoreLocalBlob('settings/local', 'rolled-back', 'application/json');
    throw new Error('rollback');
  })());
  assert.deepEqual(await manager.get('settings/local'), legacySettings);
  let restoredGeneration = 0;
  db.transaction(() => {
    restoredGeneration = manager.restoreLocalBlob(
      'settings/local',
      'restored',
      'application/json',
    ).generation;
  })();
  assert.equal(restoredGeneration, Number(generationBeforeSeed) + 1);
  assert.equal((await manager.get('settings/local'))?.toString('utf8'), 'restored');
  await manager.processDue();

  // The normal read path must stay local even when a remote object exists.
  remoteObjects.set('missing-locally', {
    content: Buffer.from('remote'),
    checksum: 'irrelevant',
    generation: 1,
  });
  assert.equal(await manager.get('missing-locally'), null);
  assert.equal(remoteGets, 0);

  // Enqueue calls participate in an existing transaction and roll back with it.
  assert.throws(() => db.transaction(() => {
    manager.enqueueReplicaPut('v1/users/local/manuscripts/rolled/metadata.json', 'rolled');
    throw new Error('rollback');
  })());
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM storage_replication_outbox WHERE key LIKE '%/rolled/%'
    `).get() as { n: number }).n,
    0,
  );

  // A generation-1 completion cannot delete or acknowledge generation 2.
  const raceKey = 'v1/users/local/manuscripts/race/metadata.json';
  manager.enqueueReplicaPut(raceKey, 'one', 'application/json');
  await firstStarted;
  manager.enqueueReplicaPut(raceKey, 'two', 'application/json');
  releaseFirst();
  await manager.syncKey(raceKey);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(raceCalls, [
    { content: 'one', generation: 1 },
    { content: 'two', generation: 2 },
  ]);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM storage_replication_outbox WHERE key = ?
    `).get(raceKey) as { n: number }).n,
    0,
  );
  assert.equal(remoteObjects.get(raceKey)?.content.toString('utf8'), 'two');

  const deletedLocalKey = 'covers/local/deleted.png';
  const deletedReplicaKey = 'v1/users/local/covers/deleted.png';
  manager.restoreLocalBlob(deletedLocalKey, Buffer.from('cover'), 'image/png');
  await manager.processDue();
  await manager.delete(deletedLocalKey);
  await manager.processDue();

  const verified = await manager.verify('v1/users/local/');
  assert.equal(verified.checked, 4);
  assert.equal(verified.matched, 4);
  assert.deepEqual(verified.missing, []);
  assert.deepEqual(verified.unexpected, []);
  assert.deepEqual(verified.mismatched, []);

  // HEAD metadata alone is not integrity verification. A body replaced while
  // retaining Chronicle's checksum/generation metadata must still fail.
  const corruptKey = raceKey;
  const expectedRace = remoteObjects.get(corruptKey)!;
  remoteObjects.set(corruptKey, {
    ...expectedRace,
    content: Buffer.from('corrupt body with plausible metadata'),
  });
  const corrupt = await manager.verify('v1/users/local/');
  assert.deepEqual(corrupt.mismatched, [{
    key: corruptKey,
    expectedChecksum: expectedRace.checksum,
    actualChecksum: sha256(Buffer.from('corrupt body with plausible metadata')),
    expectedGeneration: expectedRace.generation,
    actualGeneration: expectedRace.generation,
  }]);
  remoteObjects.set(corruptKey, expectedRace);

  // A stale remote object must not satisfy a desired DELETE.
  remoteObjects.set(deletedReplicaKey, {
    content: Buffer.from('stale cover'),
    checksum: 'stale',
    generation: 1,
  });
  const staleDelete = await manager.verify('v1/users/local/');
  assert.deepEqual(staleDelete.unexpected, [deletedReplicaKey]);

  // Verification must also discover remote orphans that have no manifest row,
  // while retaining (and not duplicating) the desired-delete finding above.
  const orphanReplicaKey = 'v1/users/local/orphaned-object.bin';
  remoteObjects.set(orphanReplicaKey, {
    content: Buffer.from('orphaned remote bytes'),
    checksum: 'orphaned',
    generation: 1,
  });
  const withOrphan = await manager.verify('v1/users/local/');
  assert.deepEqual(withOrphan.unexpected, [deletedReplicaKey, orphanReplicaKey]);

  manager.close();
  storage.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('storage replication tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
