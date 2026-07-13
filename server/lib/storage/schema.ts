import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { db } from '../../db';
import { portableReplicaKey } from './keys';

const STORAGE_MIGRATION = 'storage_001_blob_store';

export function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function contentTypeForLegacyKey(key: string): string {
  if (key.startsWith('settings/') || key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.html')) return 'text/html; charset=utf-8';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function decodeLegacyValue(key: string, value: string): Buffer {
  // These prefixes were written as Buffer values by SQLiteProvider and were
  // therefore base64 encoded. Manuscript replica objects were written as text.
  if (!key.startsWith('covers/') && !key.startsWith('settings/')) {
    return Buffer.from(value, 'utf8');
  }

  const normalized = value.replace(/\s+/g, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(normalized)) {
    throw new Error(`Legacy storage value for ${key} is not valid base64.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== normalized) {
    throw new Error(`Legacy storage value for ${key} failed base64 verification.`);
  }
  return decoded;
}

/**
 * Storage migrations live here temporarily so the storage subsystem can be
 * initialized independently. They are idempotent and use the same migration
 * ledger/transaction semantics as server/db.ts.
 */
export function initializeStorageSchema(database: Database.Database = db): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS storage_blobs (
      key           TEXT PRIMARY KEY,
      content       BLOB NOT NULL,
      content_type  TEXT,
      checksum      TEXT NOT NULL,
      generation    INTEGER NOT NULL CHECK (generation > 0),
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS storage_replica_generations (
      key         TEXT PRIMARY KEY,
      generation  INTEGER NOT NULL CHECK (generation > 0)
    );

    CREATE TABLE IF NOT EXISTS storage_replica_manifest (
      key           TEXT PRIMARY KEY,
      operation     TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
      payload       BLOB,
      content_type  TEXT,
      checksum      TEXT,
      generation    INTEGER NOT NULL CHECK (generation > 0),
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS storage_replication_outbox (
      key              TEXT PRIMARY KEY,
      operation        TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
      payload          BLOB,
      content_type     TEXT,
      checksum         TEXT,
      generation       INTEGER NOT NULL CHECK (generation > 0),
      attempts         INTEGER NOT NULL DEFAULT 0,
      next_attempt_at  INTEGER NOT NULL DEFAULT 0,
      last_attempt_at  INTEGER,
      last_error       TEXT,
      dead_letter      INTEGER NOT NULL DEFAULT 0 CHECK (dead_letter IN (0, 1)),
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_storage_outbox_due
      ON storage_replication_outbox(dead_letter, next_attempt_at, created_at);

    CREATE TABLE IF NOT EXISTS storage_replication_state (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      initialized_at   INTEGER,
      last_attempt_at  INTEGER,
      last_success_at  INTEGER,
      last_error       TEXT
    );
    INSERT OR IGNORE INTO storage_replication_state(id) VALUES (1);
  `);

  // Backfill a desired-state manifest even when a prior build already created
  // storage_blobs. INSERT OR IGNORE preserves any newer put/delete intent.
  const manifestBlob = database.prepare(`
    INSERT OR IGNORE INTO storage_replica_manifest(
      key, operation, payload, content_type, checksum, generation, updated_at
    ) VALUES (?, 'put', ?, ?, ?, ?, ?)
  `);
  const ensurePortableGeneration = database.prepare(`
    INSERT INTO storage_replica_generations(key, generation) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET generation = MAX(generation, excluded.generation)
  `);
  const selectExistingBlobs = database.prepare(`
    SELECT key, content, content_type, checksum, generation, updated_at
    FROM storage_blobs
  `);
  const backfillManifest = database.transaction(() => {
    const blobs = selectExistingBlobs.all() as Array<{
      key: string;
      content: Buffer;
      content_type: string | null;
      checksum: string;
      generation: number;
      updated_at: number;
    }>;
    for (const blob of blobs) {
      const replicaKey = portableReplicaKey(blob.key);
      manifestBlob.run(
        replicaKey,
        blob.content,
        blob.content_type,
        blob.checksum,
        blob.generation,
        blob.updated_at,
      );
      ensurePortableGeneration.run(replicaKey, blob.generation);
    }
  });
  backfillManifest();

  const applied = database
    .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
    .get(STORAGE_MIGRATION);
  if (applied) return;

  const migrate = database.transaction(() => {
    const legacyRows = database.prepare(`
      SELECT k, v FROM kv
      WHERE k LIKE 'covers/%'
         OR k LIKE 'settings/%'
         OR k LIKE 'manuscripts/%'
      ORDER BY k
    `).all() as Array<{ k: string; v: string }>;

    const insertBlob = database.prepare(`
      INSERT INTO storage_blobs(key, content, content_type, checksum, generation, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(key) DO NOTHING
    `);
    const insertGeneration = database.prepare(`
      INSERT INTO storage_replica_generations(key, generation) VALUES (?, 1)
      ON CONFLICT(key) DO UPDATE SET generation = MAX(generation, 1)
    `);
    const getBlob = database.prepare(
      'SELECT content, checksum FROM storage_blobs WHERE key = ?',
    );
    const deleteLegacy = database.prepare('DELETE FROM kv WHERE k = ?');

    for (const row of legacyRows) {
      const content = decodeLegacyValue(row.k, row.v);
      const checksum = sha256(content);
      insertBlob.run(
        row.k,
        content,
        contentTypeForLegacyKey(row.k),
        checksum,
        Date.now(),
      );
      insertGeneration.run(row.k);

      const stored = getBlob.get(row.k) as { content: Buffer; checksum: string } | undefined;
      if (!stored || stored.checksum !== checksum || !Buffer.from(stored.content).equals(content)) {
        throw new Error(`Legacy storage migration verification failed for ${row.k}.`);
      }
      // The legacy row is removed only after its byte-for-byte verification;
      // any failure rolls back this entire migration and preserves every row.
      deleteLegacy.run(row.k);
    }

    // Preserve pending jobs from the pre-generation hybrid manager when its
    // table exists. Payload is snapshotted so later local writes cannot change
    // what an in-flight generation represents.
    const hasLegacyOutbox = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'storage_outbox'
    `).get();
    if (hasLegacyOutbox) {
      const jobs = database.prepare(`
        SELECT key, action, content_type, attempts, last_attempt_at FROM storage_outbox
      `).all() as Array<{
        key: string;
        action: 'put' | 'delete';
        content_type: string | null;
        attempts: number;
        last_attempt_at: number | null;
      }>;
      const enqueue = database.prepare(`
        INSERT INTO storage_replication_outbox(
          key, operation, payload, content_type, checksum, generation,
          attempts, next_attempt_at, last_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
        ON CONFLICT(key) DO NOTHING
      `);
      for (const job of jobs) {
        const blob = getBlob.get(job.key) as { content: Buffer; checksum: string } | undefined;
        if (job.action === 'put' && !blob) continue;
        insertGeneration.run(job.key);
        const replicaKey = portableReplicaKey(job.key);
        database.prepare(`
          INSERT INTO storage_replica_manifest(
            key, operation, payload, content_type, checksum, generation, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(key) DO UPDATE SET
            operation = excluded.operation,
            payload = excluded.payload,
            content_type = excluded.content_type,
            checksum = excluded.checksum,
            generation = excluded.generation,
            updated_at = excluded.updated_at
        `).run(
          replicaKey,
          job.action,
          job.action === 'put' ? blob!.content : null,
          job.content_type,
          job.action === 'put' ? blob!.checksum : null,
          Date.now(),
        );
        enqueue.run(
          replicaKey,
          job.action,
          job.action === 'put' ? blob!.content : null,
          job.content_type,
          job.action === 'put' ? blob!.checksum : null,
          job.attempts || 0,
          job.last_attempt_at,
          Date.now(),
        );
      }
    }

    database.prepare(
      'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)',
    ).run(STORAGE_MIGRATION, Date.now());
  });

  migrate();
  backfillManifest();
  console.log(`[db] applied migration ${STORAGE_MIGRATION}`);
}

export function nextStorageGeneration(
  key: string,
  database: Database.Database = db,
): number {
  const row = database.prepare(`
    INSERT INTO storage_replica_generations(key, generation) VALUES (?, 1)
    ON CONFLICT(key) DO UPDATE SET generation = generation + 1
    RETURNING generation
  `).get(key) as { generation: number };
  return row.generation;
}
