import { config } from '../../config';
import { db } from '../../db';
import { NextcloudProvider } from './NextcloudProvider';
import { S3Provider } from './S3Provider';
import { SQLiteProvider } from './SQLiteProvider';
import { portableReplicaKey } from './keys';
import { nextStorageGeneration, sha256 } from './schema';
import type {
  ReplicaObjectMetadata,
  ReplicaProvider,
  ReplicaVerificationResult,
  ReplicationStatus,
  StorageMutation,
  StorageProvider,
} from './types';

type OutboxRow = {
  key: string;
  operation: 'put' | 'delete';
  payload: Buffer | null;
  content_type: string | null;
  checksum: string | null;
  generation: number;
  attempts: number;
  next_attempt_at: number;
  dead_letter: number;
};

type StateRow = {
  initialized_at: number | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
};

type ManifestRow = {
  key: string;
  operation: 'put' | 'delete';
  payload: Buffer | null;
  content_type: string | null;
  checksum: string | null;
  generation: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2_000);
  return String(error).slice(0, 2_000);
}

function createReplica(): ReplicaProvider | null {
  if (config.storage.replica === 'nextcloud') return new NextcloudProvider();
  if (config.storage.replica === 's3') return new S3Provider();
  return null;
}

/**
 * SQLite-first storage plus a durable, generation-aware replication outbox.
 * The historical class name is retained because routes import this module.
 */
export class HybridStorageManager implements StorageProvider {
  private readonly local = new SQLiteProvider();
  private readonly remote = createReplica();
  private readonly keyLocks = new Map<string, Promise<void>>();
  private initializePromise: Promise<void> | null = null;
  private initialized = false;
  private readonly retryTimer: NodeJS.Timeout;

  constructor() {
    // Let server startup run validateConfig() before this microtask touches a
    // remote service, then proactively validate the configured replica.
    queueMicrotask(() => {
      void this.initializeReplica()
        .then(() => this.processDue())
        .catch(() => undefined);
    });
    this.retryTimer = setInterval(() => {
      void this.processDue().catch(() => undefined);
    }, config.storage.retryIntervalMs);
    this.retryTimer.unref();
  }

  private updateState(fields: {
    initializedAt?: number | null;
    lastAttemptAt?: number | null;
    lastSuccessAt?: number | null;
    lastError?: string | null;
  }): void {
    const current = db.prepare(`
      SELECT initialized_at, last_attempt_at, last_success_at, last_error
      FROM storage_replication_state WHERE id = 1
    `).get() as StateRow;
    db.prepare(`
      UPDATE storage_replication_state SET
        initialized_at = ?,
        last_attempt_at = ?,
        last_success_at = ?,
        last_error = ?
      WHERE id = 1
    `).run(
      fields.initializedAt === undefined ? current.initialized_at : fields.initializedAt,
      fields.lastAttemptAt === undefined ? current.last_attempt_at : fields.lastAttemptAt,
      fields.lastSuccessAt === undefined ? current.last_success_at : fields.lastSuccessAt,
      fields.lastError === undefined ? current.last_error : fields.lastError,
    );
  }

  /** Validate remote configuration/connectivity (including S3 HeadBucket). */
  async initializeReplica(): Promise<void> {
    if (!this.remote || this.initialized) return;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.remote.initialize()
      .then(() => {
        this.initialized = true;
        this.updateState({ initializedAt: Date.now(), lastError: null });
      })
      .catch((error) => {
        this.initialized = false;
        this.updateState({ lastAttemptAt: Date.now(), lastError: errorMessage(error) });
        throw error;
      })
      .finally(() => {
        this.initializePromise = null;
      });
    return this.initializePromise;
  }

  private enqueueAtGeneration(
    key: string,
    operation: 'put' | 'delete',
    generation: number,
    payload?: Buffer,
    contentType?: string,
    checksum?: string,
  ): void {
    db.prepare(`
      INSERT INTO storage_replica_manifest(
        key, operation, payload, content_type, checksum, generation, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        operation = excluded.operation,
        payload = excluded.payload,
        content_type = excluded.content_type,
        checksum = excluded.checksum,
        generation = excluded.generation,
        updated_at = excluded.updated_at
      WHERE excluded.generation > storage_replica_manifest.generation
         OR (
           excluded.generation = storage_replica_manifest.generation
           AND excluded.operation = storage_replica_manifest.operation
           AND COALESCE(excluded.checksum, '') = COALESCE(storage_replica_manifest.checksum, '')
         )
    `).run(
      key,
      operation,
      payload || null,
      contentType || null,
      checksum || null,
      generation,
      Date.now(),
    );

    if (!this.remote) return;
    db.prepare(`
      INSERT INTO storage_replication_outbox(
        key, operation, payload, content_type, checksum, generation,
        attempts, next_attempt_at, last_attempt_at, last_error,
        dead_letter, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, 0, ?)
      ON CONFLICT(key) DO UPDATE SET
        operation = excluded.operation,
        payload = excluded.payload,
        content_type = excluded.content_type,
        checksum = excluded.checksum,
        generation = excluded.generation,
        attempts = 0,
        next_attempt_at = 0,
        last_attempt_at = NULL,
        last_error = NULL,
        dead_letter = 0,
        created_at = excluded.created_at
      WHERE excluded.generation > storage_replication_outbox.generation
         OR (
           excluded.generation = storage_replication_outbox.generation
           AND excluded.operation = storage_replication_outbox.operation
           AND COALESCE(excluded.checksum, '') = COALESCE(storage_replication_outbox.checksum, '')
         )
    `).run(
      key,
      operation,
      payload || null,
      contentType || null,
      checksum || null,
      generation,
      Date.now(),
    );
  }

  private scheduleKey(key: string): void {
    if (!this.remote) return;
    queueMicrotask(() => {
      void this.syncKey(key).catch(() => undefined);
    });
  }

  async put(key: string, content: Buffer | string, contentType?: string): Promise<void> {
    this.restoreLocalBlob(key, content, contentType);
  }

  /**
   * Synchronous local blob write for atomic restore/import transactions.
   * Local content, generation, desired manifest, and outbox mutate together.
   */
  restoreLocalBlob(
    key: string,
    content: Buffer | string,
    contentType?: string,
  ): StorageMutation {
    const payload = this.local.toBuffer(content);
    const checksum = sha256(payload);
    const replicaKey = portableReplicaKey(key);
    const write = () => {
      const generation = nextStorageGeneration(key);
      this.local.putAtGeneration(key, payload, contentType, generation, checksum);
      this.enqueueAtGeneration(
        replicaKey,
        'put',
        generation,
        payload,
        contentType,
        checksum,
      );
      return { key, checksum, generation };
    };
    const mutation = db.inTransaction ? write() : db.transaction(write)();
    this.scheduleKey(replicaKey);
    return mutation;
  }

  async get(key: string): Promise<Buffer | null> {
    // The remote replica is deliberately never part of the live read path.
    return this.local.get(key);
  }

  async delete(key: string): Promise<void> {
    db.transaction(() => {
      const generation = nextStorageGeneration(key);
      this.local.deleteAtGeneration(key, generation);
      this.enqueueAtGeneration(portableReplicaKey(key), 'delete', generation);
    })();
    this.scheduleKey(portableReplicaKey(key));
  }

  /**
   * Transaction-friendly physical deletion for a bounded local blob prefix.
   * Database-record tombstones remain portable PUTs; covers/settings are
   * blobs and therefore keep normal remote DELETE semantics.
   */
  deleteLocalBlobsByPrefix(prefix: string): number {
    const remove = () => {
      const records = this.local.listRecords(prefix);
      for (const record of records) {
        const generation = nextStorageGeneration(record.key);
        this.local.deleteAtGeneration(record.key, generation);
        this.enqueueAtGeneration(portableReplicaKey(record.key), 'delete', generation);
      }
      return records.map((record) => portableReplicaKey(record.key));
    };
    const keys = db.inTransaction ? remove() : db.transaction(remove)();
    for (const key of keys) this.scheduleKey(key);
    return keys.length;
  }

  async list(prefix: string): Promise<string[]> {
    return this.local.list(prefix);
  }

  async ensureDir(_path: string): Promise<void> {
    // Directories are a provider implementation detail and are created while
    // processing outbox jobs, never synchronously in a request's write path.
  }

  /**
   * Snapshot a non-storage_blobs record into the durable outbox. This method
   * is synchronous by design: when called inside a better-sqlite3 transaction,
   * the authoritative row and replica job commit or roll back together.
   */
  enqueueReplicaPut(
    key: string,
    content: Buffer | string,
    contentType?: string,
  ): StorageMutation {
    const payload = this.local.toBuffer(content);
    const checksum = sha256(payload);
    const write = () => {
      const generation = nextStorageGeneration(key);
      this.enqueueAtGeneration(key, 'put', generation, payload, contentType, checksum);
      return { key, checksum, generation };
    };
    const mutation = db.inTransaction ? write() : db.transaction(write)();
    this.scheduleKey(key);
    return mutation;
  }

  /** Transaction-friendly delete counterpart for records owned by other tables. */
  enqueueReplicaDelete(key: string): StorageMutation {
    const write = () => {
      const generation = nextStorageGeneration(key);
      this.enqueueAtGeneration(key, 'delete', generation);
      return { key, generation };
    };
    const mutation = db.inTransaction ? write() : db.transaction(write)();
    this.scheduleKey(key);
    return mutation;
  }

  /**
   * Bootstrap current local blobs without advancing their generations. This
   * is safe to call when a replica is first enabled or its target changes.
   */
  seedLocalBlobs(prefix = ''): number {
    const records = this.local.listRecords(prefix);
    db.transaction(() => {
      for (const record of records) {
        this.enqueueAtGeneration(
          portableReplicaKey(record.key),
          'put',
          record.generation,
          record.content,
          record.contentType,
          record.checksum,
        );
      }
    })();
    for (const record of records) this.scheduleKey(portableReplicaKey(record.key));
    return records.length;
  }

  /** Requeue every recorded desired object, including portable DB snapshots. */
  seedReplicaManifest(prefix = ''): number {
    if (!this.remote) return 0;
    const rows = db.prepare(`
      SELECT key, operation, payload, content_type, checksum, generation
      FROM storage_replica_manifest
      WHERE substr(key, 1, length(?)) = ?
      ORDER BY key
    `).all(prefix, prefix) as ManifestRow[];
    db.transaction(() => {
      for (const row of rows) {
        this.enqueueAtGeneration(
          row.key,
          row.operation,
          row.generation,
          row.payload || undefined,
          row.content_type || undefined,
          row.checksum || undefined,
        );
      }
    })();
    for (const row of rows) this.scheduleKey(row.key);
    return rows.length;
  }

  private getJob(key: string): OutboxRow | undefined {
    return db.prepare(`
      SELECT key, operation, payload, content_type, checksum, generation,
             attempts, next_attempt_at, dead_letter
      FROM storage_replication_outbox WHERE key = ?
    `).get(key) as OutboxRow | undefined;
  }

  private backoffMs(failedAttempts: number): number {
    const base = Math.min(300_000, 1_000 * (2 ** Math.min(failedAttempts - 1, 8)));
    return base + Math.floor(Math.random() * Math.max(1, base * 0.2));
  }

  private async syncJob(job: OutboxRow): Promise<void> {
    if (!this.remote) return;
    const attemptedAt = Date.now();
    db.prepare(`
      UPDATE storage_replication_outbox
      SET last_attempt_at = ?
      WHERE key = ? AND generation = ?
    `).run(attemptedAt, job.key, job.generation);
    this.updateState({ lastAttemptAt: attemptedAt });

    try {
      await this.initializeReplica();
      if (job.operation === 'put') {
        if (!job.payload || !job.checksum) {
          throw new Error(`Replica PUT ${job.key} has no payload or checksum.`);
        }
        await this.remote.put(job.key, Buffer.from(job.payload), {
          contentType: job.content_type || undefined,
          checksum: job.checksum,
          generation: job.generation,
        });
      } else {
        await this.remote.delete(job.key);
      }

      // A completion may acknowledge only the generation it actually sent.
      // If a new write replaced the row while I/O was in flight, it remains.
      db.prepare(`
        DELETE FROM storage_replication_outbox
        WHERE key = ? AND generation = ?
      `).run(job.key, job.generation);
      this.updateState({ lastSuccessAt: Date.now(), lastError: null });
    } catch (error) {
      const attempts = job.attempts + 1;
      const deadLetter = attempts >= config.storage.maxAttempts ? 1 : 0;
      db.prepare(`
        UPDATE storage_replication_outbox SET
          attempts = ?,
          next_attempt_at = ?,
          last_attempt_at = ?,
          last_error = ?,
          dead_letter = ?
        WHERE key = ? AND generation = ?
      `).run(
        attempts,
        attemptedAt + this.backoffMs(attempts),
        attemptedAt,
        errorMessage(error),
        deadLetter,
        job.key,
        job.generation,
      );
      this.updateState({ lastAttemptAt: attemptedAt, lastError: errorMessage(error) });
      throw error;
    }
  }

  private async drainKey(key: string): Promise<void> {
    while (true) {
      const job = this.getJob(key);
      if (!job || job.dead_letter || job.next_attempt_at > Date.now()) return;
      await this.syncJob(job);
    }
  }

  /** Serialize writes per key while allowing unrelated keys to progress. */
  syncKey(key: string): Promise<void> {
    const active = this.keyLocks.get(key);
    if (active) return active;
    const run = this.drainKey(key).finally(() => {
      this.keyLocks.delete(key);
      const remaining = this.getJob(key);
      if (remaining && !remaining.dead_letter && remaining.next_attempt_at <= Date.now()) {
        this.scheduleKey(key);
      }
    });
    this.keyLocks.set(key, run);
    return run;
  }

  /** Process currently due jobs; future backoff rows remain untouched. */
  async processDue(limit = 20): Promise<void> {
    if (!this.remote) return;
    const rows = db.prepare(`
      SELECT key FROM storage_replication_outbox
      WHERE dead_letter = 0 AND next_attempt_at <= ?
      ORDER BY created_at
      LIMIT ?
    `).all(Date.now(), limit) as Array<{ key: string }>;
    if (rows.length === 0 && !this.initialized) {
      // Keep readiness current even when there are no objects waiting to sync.
      await this.initializeReplica().catch(() => undefined);
      return;
    }
    await Promise.all(rows.map((row) => this.syncKey(row.key).catch(() => undefined)));
  }

  /** Requeue dead letters (all, or one exact key) for an immediate retry. */
  retryDeadLetters(key?: string): number {
    const keys = (key
      ? db.prepare(`
          SELECT key FROM storage_replication_outbox
          WHERE dead_letter = 1 AND key = ?
        `).all(key)
      : db.prepare(`
          SELECT key FROM storage_replication_outbox WHERE dead_letter = 1
        `).all()) as Array<{ key: string }>;
    const result = key
      ? db.prepare(`
          UPDATE storage_replication_outbox SET
            attempts = 0, next_attempt_at = 0, last_error = NULL, dead_letter = 0
          WHERE dead_letter = 1 AND key = ?
        `).run(key)
      : db.prepare(`
          UPDATE storage_replication_outbox SET
            attempts = 0, next_attempt_at = 0, last_error = NULL, dead_letter = 0
          WHERE dead_letter = 1
        `).run();
    for (const row of keys) this.scheduleKey(row.key);
    return result.changes;
  }

  getStatus(): ReplicationStatus {
    const counts = db.prepare(`
      SELECT COUNT(*) AS pending,
             COALESCE(SUM(CASE WHEN dead_letter = 1 THEN 1 ELSE 0 END), 0) AS dead_letters
      FROM storage_replication_outbox
    `).get() as { pending: number; dead_letters: number };
    const state = db.prepare(`
      SELECT initialized_at, last_attempt_at, last_success_at, last_error
      FROM storage_replication_state WHERE id = 1
    `).get() as StateRow;
    const disabled = !this.remote;
    const degraded = !disabled && (
      !this.initialized || counts.dead_letters > 0 || state.last_error !== null
    );
    return {
      provider: this.remote?.name || 'none',
      state: disabled ? 'disabled' : degraded ? 'degraded' : 'healthy',
      initialized: disabled || this.initialized,
      pending: counts.pending,
      deadLetters: counts.dead_letters,
      lastAttemptAt: state.last_attempt_at,
      lastSuccessAt: state.last_success_at,
      lastError: state.last_error,
    };
  }

  /** Verify desired local blobs and portable DB snapshots against the replica. */
  async verify(prefix = ''): Promise<ReplicaVerificationResult> {
    if (!this.remote) throw new Error('Remote replication is disabled.');
    await this.initializeReplica();
    const result: ReplicaVerificationResult = {
      checked: 0,
      matched: 0,
      missing: [],
      unexpected: [],
      mismatched: [],
      unverifiable: [],
    };
    const desired = db.prepare(`
      SELECT key, operation, checksum, generation
      FROM storage_replica_manifest
      WHERE substr(key, 1, length(?)) = ?
      ORDER BY key
    `).all(prefix, prefix) as Array<{
      key: string;
      operation: 'put' | 'delete';
      checksum: string | null;
      generation: number;
    }>;
    const desiredKeys = new Set(desired.map((entry) => entry.key));
    for (const local of desired) {
      result.checked += 1;
      const remote = await this.remote.head(local.key);
      if (local.operation === 'delete') {
        if (remote) result.unexpected.push(local.key);
        else result.matched += 1;
        continue;
      }
      if (!remote) {
        result.missing.push(local.key);
        continue;
      }

      // HEAD metadata is useful for diagnosing generations, but it is not
      // proof that the object bytes are intact: an operator or S3-compatible
      // gateway can replace a body while preserving user metadata. `verify`
      // is an explicit administrative operation, so pay the read cost and
      // hash the actual remote payload before reporting a match.
      const content = await this.remote.get(local.key);
      if (content === null) {
        result.missing.push(local.key);
        continue;
      }
      const actualChecksum = sha256(content);
      const checksumMatches = actualChecksum.toLowerCase() === local.checksum!.toLowerCase();
      const metadataChecksumMatches = remote.checksum === undefined ||
        remote.checksum.toLowerCase() === local.checksum!.toLowerCase();
      const generationMatches = remote.generation === undefined ||
        remote.generation === local.generation;
      if (!checksumMatches || !metadataChecksumMatches || !generationMatches) {
        result.mismatched.push({
          key: local.key,
          expectedChecksum: local.checksum!,
          actualChecksum,
          expectedGeneration: local.generation,
          actualGeneration: remote.generation,
        });
      } else if (remote.checksum === undefined || remote.generation === undefined) {
        // The bytes match, but a provider that drops Chronicle metadata cannot
        // prove which desired generation produced them.
        result.unverifiable.push(local.key);
      } else {
        result.matched += 1;
      }
    }

    // Verification is bidirectional: an object can survive remotely after its
    // local manifest row is lost or a buggy historical client wrote outside
    // the desired set. Desired DELETE keys are already handled above, so the
    // set check also prevents those from being reported twice.
    const unexpected = new Set(result.unexpected);
    for (const remote of await this.remote.list(prefix)) {
      if (!desiredKeys.has(remote.key)) unexpected.add(remote.key);
    }
    result.unexpected = [...unexpected].sort();
    return result;
  }

  /** Explicit remote access for restore/verification tooling, never live routes. */
  async listReplica(prefix = ''): Promise<ReplicaObjectMetadata[]> {
    if (!this.remote) throw new Error('Remote replication is disabled.');
    await this.initializeReplica();
    return this.remote.list(prefix);
  }

  /** Explicit remote access for restore tooling, never the normal read path. */
  async getReplica(key: string): Promise<Buffer | null> {
    if (!this.remote) throw new Error('Remote replication is disabled.');
    await this.initializeReplica();
    return this.remote.get(key);
  }

  close(): void {
    clearInterval(this.retryTimer);
    this.remote?.close?.();
  }
}

export { HybridStorageManager as ReplicationManager };

// Existing cover/settings routes consume this stable singleton.
export const storage = new HybridStorageManager();
