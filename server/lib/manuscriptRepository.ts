import { db } from '../db';
import { evictCollaborationResidue } from './collabEviction';
import {
  enqueueChapterReplica,
  enqueueChapterReplicaTombstone,
  enqueueManuscriptReplica,
  enqueueManuscriptReplicaTombstone,
} from './portableReplica';

export interface ChapterRecord {
  id: string;
  title: string;
  content: string;
  lastModified: number;
  revision?: number;
}

export interface ManuscriptRecord {
  metadata: {
    id: string;
    title: string;
    author: string;
    lastModified: number;
    revision?: number;
    [key: string]: unknown;
  };
  chapters: ChapterRecord[];
}

export interface RecordConflict {
  entity: 'manuscript' | 'chapter';
  id: string;
  manuscriptId?: string;
  expectedRevision?: number;
  currentRevision: number;
  reason: 'stale-revision' | 'stale-timestamp' | 'deleted' | 'already-exists';
}

export interface SaveResult {
  manuscript: ManuscriptRecord | null;
  conflicts: RecordConflict[];
}

interface ManuscriptRow {
  data: string;
  last_modified: number;
  deleted_at: number | null;
  revision: number;
}

interface ChapterRow {
  id: string;
  title: string | null;
  content: string | null;
  position: number | null;
  last_modified: number;
  deleted_at: number | null;
  revision: number;
}

const change = db.prepare(`
  INSERT INTO change_log
    (user_id, entity, manuscript_id, record_id, operation, revision, changed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export function manuscriptTombstoneData(id: string): string {
  return JSON.stringify({ id });
}

function scopedCollabDocumentName(
  userId: string,
  manuscriptId: string,
  chapterId: string,
): string {
  return `${encodeURIComponent(userId)}/${manuscriptId}:${chapterId}`;
}

/** Remove every prose-bearing collaboration residue for one deleted chapter. */
export function purgeChapterCollaborationResidue(
  userId: string,
  manuscriptId: string,
  chapterId: string,
): void {
  db.prepare('DELETE FROM ydocs WHERE name = ?').run(
    scopedCollabDocumentName(userId, manuscriptId, chapterId),
  );
  // Old web clients used unscoped names in every authentication mode. Those
  // globally ambiguous rows are unsafe to retain, even for an OIDC user.
  db.prepare('DELETE FROM ydocs WHERE name = ?').run(`${manuscriptId}:${chapterId}`);
  db.prepare(
    `DELETE FROM chapter_pre_collab
      WHERE user_id = ? AND manuscript_id = ? AND chapter_id = ?`,
  ).run(userId, manuscriptId, chapterId);
  evictCollaborationResidue({ userId, manuscriptId, chapterId });
}

/** Remove collaboration residues for every chapter beneath a deleted book. */
export function purgeManuscriptCollaborationResidue(
  userId: string,
  manuscriptId: string,
): void {
  const scopedPrefix = `${encodeURIComponent(userId)}/${manuscriptId}:`;
  db.prepare('DELETE FROM ydocs WHERE substr(name, 1, ?) = ?').run(
    scopedPrefix.length,
    scopedPrefix,
  );
  const legacyPrefix = `${manuscriptId}:`;
  db.prepare('DELETE FROM ydocs WHERE substr(name, 1, ?) = ?').run(
    legacyPrefix.length,
    legacyPrefix,
  );
  db.prepare(
    'DELETE FROM chapter_pre_collab WHERE user_id = ? AND manuscript_id = ?',
  ).run(userId, manuscriptId);
  evictCollaborationResidue({ userId, manuscriptId });
}

export function recordChange(
  userId: string,
  entity: 'manuscript' | 'chapter' | 'profile',
  manuscriptId: string | null,
  recordId: string,
  operation: 'upsert' | 'delete',
  revision: number,
  changedAt = Date.now(),
): number {
  return Number(
    change.run(userId, entity, manuscriptId, recordId, operation, revision, changedAt)
      .lastInsertRowid,
  );
}

/**
 * Advance the manuscript's aggregate revision after a child mutation.
 *
 * A manuscript DELETE carries one parent token, so chapter-only writers must
 * advance that token as well; otherwise an editor that never saw a newer
 * collaborative chapter could still delete the whole book. The helper is
 * transaction-aware and keeps the portable metadata record in the same commit.
 */
export function touchManuscriptForChapterChange(
  userId: string,
  manuscriptId: string,
  changedAt = Date.now(),
): number | null {
  const apply = () => {
    const row = db.prepare(
      `SELECT data, last_modified, revision, deleted_at FROM manuscripts
        WHERE user_id = ? AND id = ?`,
    ).get(userId, manuscriptId) as {
      data: string;
      last_modified: number;
      revision: number;
      deleted_at: number | null;
    } | undefined;
    if (!row || row.deleted_at !== null) return null;

    const revision = row.revision + 1;
    // Legacy v1 chapter writers supply their own wall-clock timestamp. A slow
    // or incorrectly configured device must not move the aggregate parent
    // clock backward when the child mutation advances its revision.
    const effectiveChangedAt = Math.max(row.last_modified, changedAt);
    const metadata = parseMetadata(row.data);
    metadata.lastModified = effectiveChangedAt;
    const data = JSON.stringify(metadata);
    db.prepare(
      `UPDATE manuscripts SET data = ?, last_modified = ?, revision = ?
        WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    ).run(data, effectiveChangedAt, revision, userId, manuscriptId);
    recordChange(
      userId,
      'manuscript',
      null,
      manuscriptId,
      'upsert',
      revision,
      effectiveChangedAt,
    );
    enqueueManuscriptReplica(
      userId,
      manuscriptId,
      data,
      effectiveChangedAt,
      revision,
    );
    return revision;
  };
  return db.inTransaction ? apply() : db.transaction(apply)();
}

function parseMetadata(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored manuscript metadata is not an object');
  }
  return parsed as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  // Metadata is produced from ordinary JSON objects. JSON.stringify gives a
  // stable-enough equality check here because both operands originate from the
  // same client/server representation; it also avoids a deep-equality runtime
  // dependency on the save path.
  return JSON.stringify(value);
}

function metadataForStorage(metadata: ManuscriptRecord['metadata']): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...metadata };
  delete clean.chapters;
  delete clean.revision;
  return clean;
}

export function loadManuscript(userId: string, id: string): ManuscriptRecord | null {
  const mRow = db
    .prepare(
      `SELECT data, last_modified, deleted_at, revision
         FROM manuscripts
        WHERE user_id = ? AND id = ?`,
    )
    .get(userId, id) as ManuscriptRow | undefined;
  if (!mRow || mRow.deleted_at !== null) return null;

  const cRows = db
    .prepare(
      `SELECT id, title, content, position, last_modified, deleted_at, revision
         FROM chapters
        WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NULL
        ORDER BY position ASC, last_modified ASC`,
    )
    .all(userId, id) as ChapterRow[];

  const metadata = parseMetadata(mRow.data) as ManuscriptRecord['metadata'];
  metadata.id = id;
  metadata.lastModified = mRow.last_modified;
  metadata.revision = mRow.revision;

  return {
    metadata,
    chapters: cRows.map((row) => ({
      id: row.id,
      title: row.title ?? '',
      content: row.content ?? '',
      lastModified: row.last_modified,
      revision: row.revision,
    })),
  };
}

export function listManuscripts(userId: string): ManuscriptRecord['metadata'][] {
  const rows = db
    .prepare(
      `SELECT id, data, last_modified, revision
         FROM manuscripts
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY last_modified DESC`,
    )
    .all(userId) as Array<{
    id: string;
    data: string;
    last_modified: number;
    revision: number;
  }>;

  return rows.map((row) => {
    const metadata = parseMetadata(row.data) as ManuscriptRecord['metadata'];
    metadata.id = row.id;
    metadata.lastModified = row.last_modified;
    metadata.revision = row.revision;
    return metadata;
  });
}

function sameMetadata(row: ManuscriptRow, incoming: Record<string, unknown>): boolean {
  return stableJson(parseMetadata(row.data)) === stableJson(incoming);
}

function sameChapter(row: ChapterRow, incoming: ChapterRecord, position: number): boolean {
  return (
    (row.title ?? '') === incoming.title &&
    (row.content ?? '') === incoming.content &&
    (row.position ?? 0) === position
  );
}

/**
 * Compatibility write for the web/mobile whole-manuscript API.
 *
 * Unlike the old implementation this never treats an omitted chapter as a
 * delete and never overwrites a newer individual record. New clients send a
 * revision; legacy clients fall back to their per-record lastModified value.
 */
export function saveLegacyManuscript(
  userId: string,
  manuscript: ManuscriptRecord,
  options: { createOnly?: boolean } = {},
): SaveResult {
  const manuscriptId = manuscript.metadata.id;
  const conflicts: RecordConflict[] = [];
  const now = Date.now();

  const transaction = db.transaction(() => {
    const currentMetadata = db
      .prepare(
        `SELECT data, last_modified, deleted_at, revision
           FROM manuscripts
          WHERE user_id = ? AND id = ?`,
      )
      .get(userId, manuscriptId) as ManuscriptRow | undefined;
    const storedMetadata = metadataForStorage(manuscript.metadata);

    if (!currentMetadata) {
      const storedData = JSON.stringify(storedMetadata);
      db.prepare(
        `INSERT INTO manuscripts
          (user_id, id, data, last_modified, deleted_at, revision)
         VALUES (?, ?, ?, ?, NULL, 1)`,
      ).run(userId, manuscriptId, storedData, now);
      recordChange(userId, 'manuscript', null, manuscriptId, 'upsert', 1, now);
      enqueueManuscriptReplica(userId, manuscriptId, storedData, now, 1);
    } else if (options.createOnly && currentMetadata.deleted_at === null) {
      conflicts.push({
        entity: 'manuscript',
        id: manuscriptId,
        currentRevision: currentMetadata.revision,
        reason: 'already-exists',
      });
    } else if (currentMetadata.deleted_at !== null) {
      conflicts.push({
        entity: 'manuscript',
        id: manuscriptId,
        expectedRevision: manuscript.metadata.revision,
        currentRevision: currentMetadata.revision,
        reason: 'deleted',
      });
    } else {
      const identical = sameMetadata(currentMetadata, storedMetadata);
      const expected = manuscript.metadata.revision;
      const revisionMatches = expected === undefined || expected === currentMetadata.revision;
      const legacyFresh =
        expected !== undefined || manuscript.metadata.lastModified > currentMetadata.last_modified;

      if (identical) {
        // A load followed by an unchanged autosave is a no-op, not a conflict.
      } else if (!revisionMatches) {
        conflicts.push({
          entity: 'manuscript',
          id: manuscriptId,
          expectedRevision: expected,
          currentRevision: currentMetadata.revision,
          reason: 'stale-revision',
        });
      } else if (!legacyFresh) {
        conflicts.push({
          entity: 'manuscript',
          id: manuscriptId,
          currentRevision: currentMetadata.revision,
          reason: 'stale-timestamp',
        });
      } else {
        const revision = currentMetadata.revision + 1;
        const storedData = JSON.stringify(storedMetadata);
        db.prepare(
          `UPDATE manuscripts
              SET data = ?, last_modified = ?, deleted_at = NULL, revision = ?
            WHERE user_id = ? AND id = ?`,
        ).run(storedData, now, revision, userId, manuscriptId);
        recordChange(userId, 'manuscript', null, manuscriptId, 'upsert', revision, now);
        enqueueManuscriptReplica(userId, manuscriptId, storedData, now, revision);
      }
    }

    // POST is create-only. If the id already exists (including as a retained
    // tombstone), do not let the request mutate or insert any child records.
    if (options.createOnly && currentMetadata) return;
    // A retained parent tombstone is authoritative. Child records must not be
    // inserted or changed beneath it even though the response already carries
    // a parent-level conflict.
    if (currentMetadata && currentMetadata.deleted_at !== null) return;

    const selectChapter = db.prepare(
      `SELECT id, title, content, position, last_modified, deleted_at, revision
         FROM chapters
        WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
    );
    const insertChapter = db.prepare(
      `INSERT INTO chapters
        (user_id, manuscript_id, id, title, content, position, last_modified, deleted_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
    );
    const updateChapter = db.prepare(
      `UPDATE chapters
          SET title = ?, content = ?, position = ?, last_modified = ?,
              deleted_at = NULL, revision = ?
        WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
    );

    let chapterMutated = false;
    manuscript.chapters.forEach((chapter, position) => {
      const current = selectChapter.get(userId, manuscriptId, chapter.id) as
        | ChapterRow
        | undefined;
      if (!current) {
        insertChapter.run(
          userId,
          manuscriptId,
          chapter.id,
          chapter.title,
          chapter.content,
          position,
          now,
        );
        recordChange(userId, 'chapter', manuscriptId, chapter.id, 'upsert', 1, now);
        enqueueChapterReplica(
          userId,
          manuscriptId,
          chapter.id,
          chapter.title,
          chapter.content,
          position,
          now,
          1,
        );
        chapterMutated = true;
        return;
      }

      if (current.deleted_at !== null) {
        conflicts.push({
          entity: 'chapter',
          id: chapter.id,
          manuscriptId,
          expectedRevision: chapter.revision,
          currentRevision: current.revision,
          reason: 'deleted',
        });
        return;
      }

      const identical = sameChapter(current, chapter, position);
      const expected = chapter.revision;
      const revisionMatches = expected === undefined || expected === current.revision;
      const legacyFresh = expected !== undefined || chapter.lastModified > current.last_modified;
      if (identical) return;
      if (!revisionMatches) {
        conflicts.push({
          entity: 'chapter',
          id: chapter.id,
          manuscriptId,
          expectedRevision: expected,
          currentRevision: current.revision,
          reason: 'stale-revision',
        });
        return;
      }
      if (!legacyFresh) {
        conflicts.push({
          entity: 'chapter',
          id: chapter.id,
          manuscriptId,
          currentRevision: current.revision,
          reason: 'stale-timestamp',
        });
        return;
      }

      const revision = current.revision + 1;
      updateChapter.run(
        chapter.title,
        chapter.content,
        position,
        now,
        revision,
        userId,
        manuscriptId,
        chapter.id,
      );
      recordChange(userId, 'chapter', manuscriptId, chapter.id, 'upsert', revision, now);
      enqueueChapterReplica(
        userId,
        manuscriptId,
        chapter.id,
        chapter.title,
        chapter.content,
        position,
        now,
        revision,
      );
      chapterMutated = true;
    });
    if (chapterMutated) touchManuscriptForChapterChange(userId, manuscriptId, now);
  });

  transaction();
  // A non-conflicting child in this same request can advance the aggregate
  // manuscript after a metadata conflict was captured. Normalize every
  // conflict token after the transaction so it agrees with the authoritative
  // manuscript returned alongside the 409 response.
  for (const conflict of conflicts) {
    const row = conflict.entity === 'manuscript'
      ? db.prepare(
          'SELECT revision FROM manuscripts WHERE user_id = ? AND id = ?',
        ).get(userId, conflict.id) as { revision: number } | undefined
      : db.prepare(`
          SELECT revision FROM chapters
          WHERE user_id = ? AND manuscript_id = ? AND id = ?
        `).get(userId, conflict.manuscriptId, conflict.id) as
          | { revision: number }
          | undefined;
    if (row) conflict.currentRevision = row.revision;
  }
  const current = loadManuscript(userId, manuscriptId);
  if (!current && conflicts.length === 0) {
    throw new Error('Manuscript disappeared during save');
  }
  return { manuscript: current, conflicts };
}

export function deleteChapter(
  userId: string,
  manuscriptId: string,
  chapterId: string,
  baseRevision?: number,
): {
  ok: true;
  revision: number;
  manuscriptRevision?: number;
} | { ok: false; currentRevision: number } | null {
  const transaction = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT revision, deleted_at FROM chapters
          WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
      )
      .get(userId, manuscriptId, chapterId) as
      | { revision: number; deleted_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.deleted_at !== null) {
      db.prepare(`
        UPDATE chapters SET title = NULL, content = NULL, position = NULL
        WHERE user_id = ? AND manuscript_id = ? AND id = ?
      `).run(userId, manuscriptId, chapterId);
      purgeChapterCollaborationResidue(userId, manuscriptId, chapterId);
      const parent = db.prepare(
        'SELECT revision FROM manuscripts WHERE user_id = ? AND id = ?',
      ).get(userId, manuscriptId) as { revision: number } | undefined;
      return {
        ok: true as const,
        revision: row.revision,
        manuscriptRevision: parent?.revision,
      };
    }
    if (baseRevision !== undefined && baseRevision !== row.revision) {
      return { ok: false as const, currentRevision: row.revision };
    }

    const revision = row.revision + 1;
    const now = Date.now();
    db.prepare(
      `UPDATE chapters
          SET title = NULL, content = NULL, position = NULL,
              deleted_at = ?, last_modified = ?, revision = ?
        WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
    ).run(now, now, revision, userId, manuscriptId, chapterId);
    purgeChapterCollaborationResidue(userId, manuscriptId, chapterId);
    recordChange(userId, 'chapter', manuscriptId, chapterId, 'delete', revision, now);
    enqueueChapterReplicaTombstone(userId, manuscriptId, chapterId, now, revision);
    const manuscriptRevision = touchManuscriptForChapterChange(userId, manuscriptId, now);
    return {
      ok: true as const,
      revision,
      manuscriptRevision: manuscriptRevision ?? undefined,
    };
  });
  return transaction();
}

export function deleteManuscript(
  userId: string,
  id: string,
  baseRevision?: number,
): { ok: true; revision: number } | { ok: false; currentRevision: number } | null {
  const transaction = db.transaction(() => {
    const manuscript = db
      .prepare('SELECT revision, deleted_at FROM manuscripts WHERE user_id = ? AND id = ?')
      .get(userId, id) as { revision: number; deleted_at: number | null } | undefined;
    if (!manuscript) return null;
    if (manuscript.deleted_at !== null) {
      db.prepare('UPDATE manuscripts SET data = ? WHERE user_id = ? AND id = ?').run(
        manuscriptTombstoneData(id),
        userId,
        id,
      );
      db.prepare(`
        UPDATE chapters SET title = NULL, content = NULL, position = NULL
        WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NOT NULL
      `).run(userId, id);
      purgeManuscriptCollaborationResidue(userId, id);
      return { ok: true as const, revision: manuscript.revision };
    }
    if (baseRevision !== undefined && baseRevision !== manuscript.revision) {
      return { ok: false as const, currentRevision: manuscript.revision };
    }

    const now = Date.now();
    const manuscriptRevision = manuscript.revision + 1;
    db.prepare(
      `UPDATE manuscripts
          SET data = ?, deleted_at = ?, last_modified = ?, revision = ?
        WHERE user_id = ? AND id = ?`,
    ).run(manuscriptTombstoneData(id), now, now, manuscriptRevision, userId, id);
    purgeManuscriptCollaborationResidue(userId, id);
    recordChange(userId, 'manuscript', null, id, 'delete', manuscriptRevision, now);
    enqueueManuscriptReplicaTombstone(userId, id, now, manuscriptRevision);

    const chapters = db
      .prepare(
        `SELECT id, revision FROM chapters
          WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NULL`,
      )
      .all(userId, id) as Array<{ id: string; revision: number }>;
    const tombstone = db.prepare(
      `UPDATE chapters
          SET title = NULL, content = NULL, position = NULL,
              deleted_at = ?, last_modified = ?, revision = ?
        WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
    );
    for (const chapter of chapters) {
      const revision = chapter.revision + 1;
      tombstone.run(now, now, revision, userId, id, chapter.id);
      recordChange(userId, 'chapter', id, chapter.id, 'delete', revision, now);
      enqueueChapterReplicaTombstone(userId, id, chapter.id, now, revision);
    }
    return { ok: true as const, revision: manuscriptRevision };
  });
  return transaction();
}
