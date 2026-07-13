import { db } from '../db';
import {
  manuscriptTombstoneData,
  purgeChapterCollaborationResidue,
  purgeManuscriptCollaborationResidue,
  recordChange,
} from './manuscriptRepository';
import type {
  PortableManuscriptRecord,
  PortableProfileRecord,
  parsePortableChapter,
} from './portableReplica';
import { storage } from './storage/HybridManager';
import { rotateSyncHistoryEpoch } from './syncHistory';

type PortableChapterRecord = ReturnType<typeof parsePortableChapter>;

export interface RestoreBlobRecord {
  remoteKey: string;
  localKey: string;
  userId: string;
  contentType: string;
  content?: Buffer;
}

export interface RestoreApplyPlan {
  manuscripts: ReadonlyArray<{ record: PortableManuscriptRecord }>;
  chapters: ReadonlyArray<{ record: PortableChapterRecord }>;
  profiles: ReadonlyArray<{ record: PortableProfileRecord }>;
  blobs: ReadonlyArray<RestoreBlobRecord>;
}

export interface RestoreApplyResult {
  cascadedChapters: number;
  skippedCovers: number;
}

function chapterIdentity(userId: string, manuscriptId: string, id: string): string {
  return `${userId}\0${manuscriptId}\0${id}`;
}

export function partitionRestoreBlobsForTombstones<T extends RestoreBlobRecord>(
  manuscripts: ReadonlyArray<{ record: PortableManuscriptRecord }>,
  blobs: ReadonlyArray<T>,
): { accepted: T[]; rejected: T[] } {
  const deletedCoverPrefixes = manuscripts
    .filter(({ record }) => record.kind === 'manuscript-tombstone')
    .map(({ record }) => `covers/${record.userId}/${record.id}.`);
  const accepted: T[] = [];
  const rejected: T[] = [];
  for (const blob of blobs) {
    const tombstoned = deletedCoverPrefixes.some((prefix) => blob.localKey.startsWith(prefix));
    (tombstoned ? rejected : accepted).push(blob);
  }
  return { accepted, rejected };
}

/**
 * Apply a validated portable restore plan to SQLite.
 *
 * This is kept importable so restore invariants can be exercised without a
 * configured network replica or spawning the CLI. The caller remains
 * responsible for the pre-restore backup and for reseeding the desired remote
 * manifest after this transaction commits.
 */
export function applyRestorePlan(plan: RestoreApplyPlan): RestoreApplyResult {
  // Legacy sync cursors are wall-clock serverTime values and pull rows with a
  // strict `last_modified > since` predicate. Portable timestamps may be much
  // older than the client cursor, so applying them verbatim would make a
  // successful restore invisible to every legacy client that synced after the
  // backup was taken. One millisecond beyond restore start is also strictly
  // newer than a serverTime issued in the same millisecond immediately before
  // the restore began. `Math.max` below never reverses a future/source order.
  const restoreVisibilityAt = Date.now() + 1;
  const restoreBlobs = partitionRestoreBlobsForTombstones(
    plan.manuscripts,
    plan.blobs,
  );
  const upsertManuscript = db.prepare(`
    INSERT INTO manuscripts(user_id, id, data, last_modified, deleted_at, revision)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      data = excluded.data,
      last_modified = excluded.last_modified,
      deleted_at = excluded.deleted_at,
      revision = excluded.revision
  `);
  const upsertChapter = db.prepare(`
    INSERT INTO chapters(
      user_id, manuscript_id, id, title, content, position,
      last_modified, deleted_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, manuscript_id, id) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      position = excluded.position,
      last_modified = excluded.last_modified,
      deleted_at = excluded.deleted_at,
      revision = excluded.revision
  `);
  const upsertProfile = db.prepare(`
    INSERT INTO profiles(user_id, data, last_modified, revision)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      data = excluded.data,
      last_modified = excluded.last_modified,
      revision = excluded.revision
  `);
  const existingManuscript = db.prepare(
    'SELECT last_modified, revision FROM manuscripts WHERE user_id = ? AND id = ?',
  );
  const existingChapter = db.prepare(`
    SELECT last_modified, revision FROM chapters
    WHERE user_id = ? AND manuscript_id = ? AND id = ?
  `);
  const existingProfile = db.prepare(
    'SELECT last_modified, revision FROM profiles WHERE user_id = ?',
  );
  const activeChildren = db.prepare(`
    SELECT id, last_modified, revision FROM chapters
    WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NULL
  `);
  const cascadeChapter = db.prepare(`
    UPDATE chapters
       SET title = NULL, content = NULL, position = NULL,
           last_modified = ?, deleted_at = ?, revision = ?
     WHERE user_id = ? AND manuscript_id = ? AND id = ? AND deleted_at IS NULL
  `);
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users(id, display_name, created_at)
    VALUES (?, ?, ?)
  `);

  const plannedChapterIds = new Set(
    plan.chapters.map(({ record }) => chapterIdentity(
      record.metadata.userId,
      record.metadata.manuscriptId,
      record.metadata.id,
    )),
  );
  let cascadedChapters = 0;

  db.transaction(() => {
    const userIds = new Set<string>();
    plan.manuscripts.forEach(({ record }) => userIds.add(record.userId));
    plan.chapters.forEach(({ record }) => userIds.add(record.metadata.userId));
    plan.profiles.forEach(({ record }) => userIds.add(record.userId));
    restoreBlobs.accepted.forEach(({ userId }) => userIds.add(userId));
    for (const id of userIds) insertUser.run(id, 'Restored User', Date.now());

    for (const { record } of plan.manuscripts) {
      const current = existingManuscript.get(record.userId, record.id) as
        | { last_modified: number; revision: number }
        | undefined;
      // A forced in-place restore must not make a previously issued optimistic
      // token valid again. New rows retain the portable revision; overwritten
      // rows advance beyond both local and portable histories.
      const revision = current
        ? Math.max(record.revision, current.revision) + 1
        : record.revision;
      const deleted = record.kind === 'manuscript-tombstone';
      const sourceChangedAt = deleted ? record.deletedAt : record.lastModified;
      const changedAt = Math.max(
        restoreVisibilityAt,
        sourceChangedAt,
        current?.last_modified ?? 0,
      );
      upsertManuscript.run(
        record.userId,
        record.id,
        deleted ? manuscriptTombstoneData(record.id) : JSON.stringify(record.metadata),
        changedAt,
        deleted ? changedAt : null,
        revision,
      );
      recordChange(
        record.userId,
        'manuscript',
        null,
        record.id,
        deleted ? 'delete' : 'upsert',
        revision,
        changedAt,
      );
      if (deleted) {
        purgeManuscriptCollaborationResidue(record.userId, record.id);
        storage.deleteLocalBlobsByPrefix(`covers/${record.userId}/${record.id}.`);
      }
    }

    // A portable parent tombstone can legitimately have no child objects (for
    // example, an older replica deleted them physically). Any local live child
    // absent from the restore plan must still become a fresh local tombstone;
    // otherwise the post-restore seed would publish its prose beneath a deleted
    // parent. Explicit replicated child tombstones are applied in the next loop.
    for (const { record } of plan.manuscripts) {
      if (record.kind !== 'manuscript-tombstone') continue;
      const children = activeChildren.all(record.userId, record.id) as Array<{
        id: string;
        last_modified: number;
        revision: number;
      }>;
      for (const child of children) {
        if (plannedChapterIds.has(chapterIdentity(record.userId, record.id, child.id))) {
          continue;
        }
        const changedAt = Math.max(
          restoreVisibilityAt,
          record.deletedAt,
          child.last_modified,
        );
        const revision = child.revision + 1;
        const result = cascadeChapter.run(
          changedAt,
          changedAt,
          revision,
          record.userId,
          record.id,
          child.id,
        );
        if (result.changes !== 1) continue;
        cascadedChapters += 1;
        purgeChapterCollaborationResidue(record.userId, record.id, child.id);
        recordChange(
          record.userId,
          'chapter',
          record.id,
          child.id,
          'delete',
          revision,
          changedAt,
        );
      }
    }

    for (const { record } of plan.chapters) {
      const metadata = record.metadata;
      const current = existingChapter.get(
        metadata.userId,
        metadata.manuscriptId,
        metadata.id,
      ) as { last_modified: number; revision: number } | undefined;
      const revision = current
        ? Math.max(metadata.revision, current.revision) + 1
        : metadata.revision;
      const deleted = metadata.kind === 'chapter-tombstone';
      const sourceChangedAt = deleted ? metadata.deletedAt : metadata.lastModified;
      const changedAt = Math.max(
        restoreVisibilityAt,
        sourceChangedAt,
        current?.last_modified ?? 0,
      );
      upsertChapter.run(
        metadata.userId,
        metadata.manuscriptId,
        metadata.id,
        deleted ? null : metadata.title,
        deleted ? null : record.content,
        deleted ? null : metadata.position,
        changedAt,
        deleted ? changedAt : null,
        revision,
      );
      recordChange(
        metadata.userId,
        'chapter',
        metadata.manuscriptId,
        metadata.id,
        deleted ? 'delete' : 'upsert',
        revision,
        changedAt,
      );
      if (deleted) {
        purgeChapterCollaborationResidue(
          metadata.userId,
          metadata.manuscriptId,
          metadata.id,
        );
      }
    }

    for (const { record } of plan.profiles) {
      const current = existingProfile.get(record.userId) as
        | { last_modified: number; revision: number }
        | undefined;
      const revision = current
        ? Math.max(record.revision, current.revision) + 1
        : record.revision;
      const changedAt = Math.max(
        restoreVisibilityAt,
        record.lastModified,
        current?.last_modified ?? 0,
      );
      upsertProfile.run(
        record.userId,
        JSON.stringify(record.profile),
        changedAt,
        revision,
      );
      recordChange(
        record.userId,
        'profile',
        null,
        'profile',
        'upsert',
        revision,
        changedAt,
      );
    }
    for (const blob of restoreBlobs.accepted) {
      if (!blob.content) throw new Error(`Restore blob was not hydrated: ${blob.remoteKey}`);
      storage.restoreLocalBlob(blob.localKey, blob.content, blob.contentType);
    }
    // Every cursor issued before this restore belongs to a different logical
    // history, even if subsequent writes make the numeric sequence catch up.
    rotateSyncHistoryEpoch();
  })();

  return {
    cascadedChapters,
    skippedCovers: restoreBlobs.rejected.length,
  };
}
