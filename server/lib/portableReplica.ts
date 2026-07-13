import crypto from 'crypto';
import { config } from '../config';
import { db } from '../db';
import { storage } from './storage/HybridManager';

export const PORTABLE_REPLICA_VERSION = 1;
export const PORTABLE_REPLICA_ROOT = `v${PORTABLE_REPLICA_VERSION}/users`;

export interface PortableLiveManuscriptRecord {
  schemaVersion: 1;
  kind: 'manuscript';
  userId: string;
  id: string;
  revision: number;
  lastModified: number;
  metadata: Record<string, unknown>;
}

export interface PortableManuscriptTombstone {
  schemaVersion: 1;
  kind: 'manuscript-tombstone';
  userId: string;
  id: string;
  revision: number;
  deletedAt: number;
}

export type PortableManuscriptRecord =
  | PortableLiveManuscriptRecord
  | PortableManuscriptTombstone;

export interface PortableLiveChapterMetadata {
  schemaVersion: 1;
  kind: 'chapter';
  userId: string;
  manuscriptId: string;
  id: string;
  title: string;
  position: number;
  revision: number;
  lastModified: number;
  contentBytes: number;
}

export interface PortableChapterTombstone {
  schemaVersion: 1;
  kind: 'chapter-tombstone';
  userId: string;
  manuscriptId: string;
  id: string;
  revision: number;
  deletedAt: number;
  contentBytes: 0;
}

export type PortableChapterMetadata =
  | PortableLiveChapterMetadata
  | PortableChapterTombstone;

export interface PortableProfileRecord {
  schemaVersion: 1;
  kind: 'profile';
  userId: string;
  revision: number;
  lastModified: number;
  profile: unknown;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function checksum(value: Buffer | string): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'))
    .digest('hex');
}

function enqueuePutIfChanged(
  key: string,
  content: Buffer | string,
  contentType: string,
): boolean {
  const desiredChecksum = checksum(content);
  const current = db
    .prepare('SELECT operation, checksum FROM storage_replica_manifest WHERE key = ?')
    .get(key) as { operation: 'put' | 'delete'; checksum: string | null } | undefined;
  if (current?.operation === 'put' && current.checksum === desiredChecksum) return false;
  storage.enqueueReplicaPut(key, content, contentType);
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function portableUserRoot(userId: string): string {
  return `${PORTABLE_REPLICA_ROOT}/${segment(userId)}`;
}

export function portableManuscriptRoot(userId: string, manuscriptId: string): string {
  return `${portableUserRoot(userId)}/manuscripts/${segment(manuscriptId)}`;
}

export function portableManuscriptKey(userId: string, manuscriptId: string): string {
  return `${portableManuscriptRoot(userId, manuscriptId)}/metadata.json`;
}

export function portableChapterKey(
  userId: string,
  manuscriptId: string,
  chapterId: string,
): string {
  return `${portableManuscriptRoot(userId, manuscriptId)}/chapters/${segment(chapterId)}.html`;
}

export function portableProfileKey(userId: string): string {
  return `${portableUserRoot(userId)}/profile.json`;
}

/**
 * Queue a portable metadata snapshot. Calls are synchronous so an enclosing
 * better-sqlite3 transaction commits the authoritative row and outbox job as
 * one unit.
 */
export function enqueueManuscriptReplica(
  userId: string,
  id: string,
  data: string,
  lastModified: number,
  revision: number,
): void {
  const record: PortableManuscriptRecord = {
    schemaVersion: 1,
    kind: 'manuscript',
    userId,
    id,
    revision,
    lastModified,
    metadata: parseObject(data, 'Manuscript metadata'),
  };
  enqueuePutIfChanged(
    portableManuscriptKey(userId, id),
    stableJson(record),
    'application/json',
  );
}

/**
 * Chapters stay human-readable HTML. The exact UTF-8 content byte length is
 * included in the metadata attribute, so restore tooling can recover the
 * original fragment even if the prose itself contains `</body>` or marker-like
 * text.
 */
export function serializePortableChapter(
  metadata: Omit<PortableLiveChapterMetadata, 'schemaVersion' | 'kind' | 'contentBytes'>,
  content: string,
): Buffer {
  const contentBuffer = Buffer.from(content, 'utf8');
  const record: PortableLiveChapterMetadata = {
    schemaVersion: 1,
    kind: 'chapter',
    ...metadata,
    contentBytes: contentBuffer.length,
  };
  return serializeChapterEnvelope(record, contentBuffer, record.title);
}

function serializeChapterEnvelope(
  record: PortableChapterMetadata,
  content: Buffer,
  title: string,
): Buffer {
  const encoded = Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
  const prefix = Buffer.from(
    '<!doctype html>\n' +
      `<html lang="en" data-chronicle-record="${encoded}">\n` +
      '<head>\n' +
      '  <meta charset="utf-8">\n' +
      `  <title>${escapeHtml(title)}</title>\n` +
      '</head>\n' +
      '<body data-chronicle-content>\n',
    'utf8',
  );
  const suffix = Buffer.from('\n</body>\n</html>\n', 'utf8');
  return Buffer.concat([prefix, content, suffix]);
}

export function serializePortableChapterTombstone(
  metadata: Omit<PortableChapterTombstone, 'schemaVersion' | 'kind' | 'contentBytes'>,
): Buffer {
  const record: PortableChapterTombstone = {
    schemaVersion: 1,
    kind: 'chapter-tombstone',
    ...metadata,
    contentBytes: 0,
  };
  return serializeChapterEnvelope(record, Buffer.alloc(0), 'Deleted Chronicle chapter');
}

export function parsePortableChapter(bytes: Buffer): {
  metadata: PortableChapterMetadata;
  content: string;
} {
  const marker = Buffer.from('<body data-chronicle-content>\n', 'utf8');
  const markerAt = bytes.indexOf(marker);
  if (markerAt < 0) throw new Error('Portable chapter is missing its content marker.');

  // Only inspect the bounded header as text; prose can be arbitrary HTML.
  const header = bytes.subarray(0, markerAt).toString('utf8');
  const encoded = /data-chronicle-record="([A-Za-z0-9_-]+)"/.exec(header)?.[1];
  if (!encoded) throw new Error('Portable chapter is missing its record metadata.');
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Portable chapter metadata is invalid.');
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.contentBytes)) {
    throw new Error('Portable chapter metadata has an unsupported shape.');
  }
  let metadata: PortableChapterMetadata;
  if (candidate.kind === 'chapter') {
    if (
      typeof candidate.userId !== 'string' ||
      typeof candidate.manuscriptId !== 'string' ||
      typeof candidate.id !== 'string' ||
      typeof candidate.title !== 'string' ||
      !Number.isSafeInteger(candidate.position) ||
      (candidate.position as number) < 0 ||
      !Number.isSafeInteger(candidate.revision) ||
      (candidate.revision as number) <= 0 ||
      !Number.isSafeInteger(candidate.lastModified) ||
      (candidate.lastModified as number) < 0 ||
      (candidate.contentBytes as number) < 0
    ) throw new Error('Portable chapter metadata has an unsupported shape.');
    metadata = candidate as unknown as PortableLiveChapterMetadata;
  } else if (candidate.kind === 'chapter-tombstone') {
    if (
      typeof candidate.userId !== 'string' ||
      typeof candidate.manuscriptId !== 'string' ||
      typeof candidate.id !== 'string' ||
      !Number.isSafeInteger(candidate.revision) ||
      (candidate.revision as number) <= 0 ||
      !Number.isSafeInteger(candidate.deletedAt) ||
      (candidate.deletedAt as number) < 0 ||
      candidate.contentBytes !== 0 ||
      Object.hasOwn(candidate, 'title') ||
      Object.hasOwn(candidate, 'position') ||
      Object.hasOwn(candidate, 'lastModified')
    ) throw new Error('Portable chapter tombstone has an unsupported shape.');
    metadata = candidate as unknown as PortableChapterTombstone;
  } else {
    throw new Error('Portable chapter metadata has an unsupported kind.');
  }
  const contentStart = markerAt + marker.length;
  const contentEnd = contentStart + metadata.contentBytes;
  const suffix = Buffer.from('\n</body>\n</html>\n', 'utf8');
  if (contentEnd > bytes.length || !bytes.subarray(contentEnd).equals(suffix)) {
    throw new Error('Portable chapter content is truncated.');
  }
  if (metadata.kind === 'chapter-tombstone' && contentEnd !== contentStart) {
    throw new Error('Portable chapter tombstones must not contain prose.');
  }
  return {
    metadata,
    content: bytes.subarray(contentStart, contentEnd).toString('utf8'),
  };
}

export function enqueueChapterReplica(
  userId: string,
  manuscriptId: string,
  id: string,
  title: string,
  content: string,
  position: number,
  lastModified: number,
  revision: number,
): void {
  const bytes = serializePortableChapter(
    { userId, manuscriptId, id, title, position, revision, lastModified },
    content,
  );
  enqueuePutIfChanged(
    portableChapterKey(userId, manuscriptId, id),
    bytes,
    'text/html; charset=utf-8',
  );
}

export function enqueueProfileReplica(
  userId: string,
  data: string,
  lastModified: number,
  revision: number,
): void {
  const record: PortableProfileRecord = {
    schemaVersion: 1,
    kind: 'profile',
    userId,
    revision,
    lastModified,
    profile: JSON.parse(data) as unknown,
  };
  enqueuePutIfChanged(
    portableProfileKey(userId),
    stableJson(record),
    'application/json',
  );
}

export function enqueueChapterReplicaTombstone(
  userId: string,
  manuscriptId: string,
  chapterId: string,
  deletedAt: number,
  revision: number,
): boolean {
  return enqueuePutIfChanged(
    portableChapterKey(userId, manuscriptId, chapterId),
    serializePortableChapterTombstone({
      userId,
      manuscriptId,
      id: chapterId,
      revision,
      deletedAt,
    }),
    'text/html; charset=utf-8',
  );
}

export function enqueueManuscriptReplicaTombstone(
  userId: string,
  manuscriptId: string,
  deletedAt: number,
  revision: number,
): boolean {
  const record: PortableManuscriptTombstone = {
    schemaVersion: 1,
    kind: 'manuscript-tombstone',
    userId,
    id: manuscriptId,
    revision,
    deletedAt,
  };
  const changed = enqueuePutIfChanged(
    portableManuscriptKey(userId, manuscriptId),
    stableJson(record),
    'application/json',
  );
  // Covers are opaque blobs, not sync records. Remove them physically while
  // the parent tombstone and deletion outbox remain in the same transaction.
  storage.deleteLocalBlobsByPrefix(`covers/${userId}/${manuscriptId}.`);
  return changed;
}

/**
 * Populate/repair the durable desired-state manifest from authoritative rows.
 * Checksums make this idempotent, so normal restarts do not advance generations
 * or re-upload unchanged manuscripts.
 */
export function seedPortableDatabaseManifest(): { checked: number; enqueued: number } {
  let checked = 0;
  let enqueued = 0;
  const seed = db.transaction(() => {
    const manuscripts = db.prepare(`
      SELECT user_id, id, data, last_modified, deleted_at, revision
      FROM manuscripts
    `).all() as Array<{
      user_id: string;
      id: string;
      data: string;
      last_modified: number;
      deleted_at: number | null;
      revision: number;
    }>;
    for (const row of manuscripts) {
      checked += 1;
      if (row.deleted_at !== null) {
        if (enqueueManuscriptReplicaTombstone(
          row.user_id,
          row.id,
          row.deleted_at,
          row.revision,
        )) enqueued += 1;
      } else {
        const record: PortableManuscriptRecord = {
          schemaVersion: 1,
          kind: 'manuscript',
          userId: row.user_id,
          id: row.id,
          revision: row.revision,
          lastModified: row.last_modified,
          metadata: parseObject(row.data, 'Manuscript metadata'),
        };
        if (
          enqueuePutIfChanged(
            portableManuscriptKey(row.user_id, row.id),
            stableJson(record),
            'application/json',
          )
        ) enqueued += 1;
      }
    }

    const chapters = db.prepare(`
      SELECT user_id, manuscript_id, id, title, content, position,
             last_modified, deleted_at, revision
      FROM chapters
    `).all() as Array<{
      user_id: string;
      manuscript_id: string;
      id: string;
      title: string | null;
      content: string | null;
      position: number | null;
      last_modified: number;
      deleted_at: number | null;
      revision: number;
    }>;
    for (const row of chapters) {
      checked += 1;
      const key = portableChapterKey(row.user_id, row.manuscript_id, row.id);
      if (row.deleted_at !== null) {
        const bytes = serializePortableChapterTombstone({
          userId: row.user_id,
          manuscriptId: row.manuscript_id,
          id: row.id,
          revision: row.revision,
          deletedAt: row.deleted_at,
        });
        if (enqueuePutIfChanged(key, bytes, 'text/html; charset=utf-8')) enqueued += 1;
      } else {
        const bytes = serializePortableChapter(
          {
            userId: row.user_id,
            manuscriptId: row.manuscript_id,
            id: row.id,
            title: row.title ?? '',
            position: row.position ?? 0,
            revision: row.revision,
            lastModified: row.last_modified,
          },
          row.content ?? '',
        );
        if (enqueuePutIfChanged(key, bytes, 'text/html; charset=utf-8')) enqueued += 1;
      }
    }

    const profiles = db.prepare(`
      SELECT user_id, data, last_modified, revision FROM profiles
    `).all() as Array<{
      user_id: string;
      data: string;
      last_modified: number;
      revision: number;
    }>;
    for (const row of profiles) {
      checked += 1;
      const record: PortableProfileRecord = {
        schemaVersion: 1,
        kind: 'profile',
        userId: row.user_id,
        revision: row.revision,
        lastModified: row.last_modified,
        profile: JSON.parse(row.data) as unknown,
      };
      if (
        enqueuePutIfChanged(
          portableProfileKey(row.user_id),
          stableJson(record),
          'application/json',
        )
      ) enqueued += 1;
    }
  });
  seed();
  return { checked, enqueued };
}

function replicaTargetFingerprint(): string {
  if (config.storage.replica === 'none') return 'none';
  const target = config.storage.replica === 's3'
    ? {
        provider: 's3',
        bucket: config.s3.bucket,
        endpoint: config.s3.endpoint,
        prefix: config.s3.prefix,
        region: config.s3.region,
      }
    : {
        provider: 'nextcloud',
        url: config.nextcloud.url,
        user: config.nextcloud.user,
        root: config.nextcloud.storageDir,
      };
  return `${config.storage.replica}:${checksum(JSON.stringify(target))}`;
}

/**
 * Requeue the complete manifest on first enable, after a disabled interval, or
 * when the configured bucket/WebDAV destination changes. Credentials are not
 * fingerprinted and are never persisted.
 */
export function reconcileReplicaTarget(): { changed: boolean; seeded: number } {
  const key = 'storage/replica-target-fingerprint';
  const target = replicaTargetFingerprint();
  const previous = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as
    | { v: string }
    | undefined;
  if (previous?.v === target) return { changed: false, seeded: 0 };

  const seeded = target === 'none' ? 0 : storage.seedReplicaManifest();
  if (target === 'none') {
    // Jobs belong to a concrete remote destination. The desired-state
    // manifest is retained, but disabling replication should not report stale
    // pending/dead-letter work or send it if another target is chosen later.
    db.prepare('DELETE FROM storage_replication_outbox').run();
  }
  db.prepare(`
    INSERT INTO kv(k, v, expires_at) VALUES (?, ?, NULL)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = NULL
  `).run(key, target);
  return { changed: true, seeded };
}
