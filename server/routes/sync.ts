import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db';
import {
  manuscriptTombstoneData,
  purgeChapterCollaborationResidue,
  purgeManuscriptCollaborationResidue,
  recordChange,
  touchManuscriptForChapterChange,
} from '../lib/manuscriptRepository';
import {
  enqueueChapterReplica,
  enqueueChapterReplicaTombstone,
  enqueueManuscriptReplica,
  enqueueManuscriptReplicaTombstone,
  enqueueProfileReplica,
} from '../lib/portableReplica';
import { getSyncHistoryEpoch } from '../lib/syncHistory';

const router = Router();

/**
 * The sync engine.
 *
 * Protocol (one round trip, both directions):
 *
 *   POST /api/sync
 *   { since: <client's last serverTime, or 0>,
 *     push: { manuscripts: [...], chapters: [...], profile: {...}|null } }
 *
 *   → { serverTime, pull: { manuscripts, chapters, profile } }
 *
 * Conflict resolution: last-write-wins per record, where the record is:
 *   - the manuscript metadata blob (one row per manuscript)
 *   - an individual chapter (one row per chapter)
 *   - the user profile (one row total)
 *
 * Granular per-chapter LWW means two devices editing different chapters of
 * the same book don't clobber each other.
 *
 * Tombstones: deleted rows stick around (with deleted_at set) so the delete
 * propagates even to clients that remain offline for a long time. They cannot
 * be compacted safely until Chronicle tracks per-device cursor acknowledgments.
 *
 * Push results are deliberately eligible for pull. A client whose stale write
 * lost conflict resolution must receive the authoritative record before it
 * advances its cursor; filtering every pushed key caused permanent divergence.
 */

const ManuscriptIn = z.object({
  id: z.string().min(1).max(64),
  data: z.string().max(50_000).refine((value) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }, 'data must be a JSON object'),
  last_modified: z.number().int().positive(),
  deleted: z.boolean().optional(),
});

const ChapterIn = z.object({
  id: z.string().min(1).max(64),
  manuscript_id: z.string().min(1).max(64),
  title: z.string().max(500).nullable().optional(),
  content: z.string().max(5_000_000).nullable().optional(),
  position: z.number().int().nullable().optional(),
  last_modified: z.number().int().positive(),
  deleted: z.boolean().optional(),
});

const ProfileIn = z.object({
  data: z.string().max(50_000).refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, 'data must be valid JSON'),
  last_modified: z.number().int().positive(),
});

const PluginStateIn = z.object({
  id: z.string().min(1).max(64),
  plugin_id: z.string().min(1).max(128),
  manuscript_id: z.string().min(1).max(64).nullable().optional(),
  enabled: z.boolean().optional(),
  state: z.string().max(100_000).default('{}'),
  last_modified: z.number().int().positive(),
});

const SyncBody = z.object({
  since: z.number().int().nonnegative().default(0),
  push: z
    .object({
      manuscripts: z.array(ManuscriptIn).default([]),
      chapters: z.array(ChapterIn).default([]),
      profile: ProfileIn.nullable().optional(),
      plugins: z.array(PluginStateIn).default([]),
    })
    .default({ manuscripts: [], chapters: [], plugins: [] }),
});

// Mounted at /api/sync, so the root route is the public POST /api/sync
// contract. The old `/sync` suffix made the real endpoint /api/sync/sync while
// every client and the documentation called /api/sync.
router.post('/', (req, res) => {
  const parsed = SyncBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid sync payload', details: parsed.error.flatten() });
    return;
  }

  const { since, push } = parsed.data;
  const userId = req.userId!;
  const serverTime = Date.now();

  const getMs = db.prepare(
    'SELECT last_modified, deleted_at, revision FROM manuscripts WHERE user_id = ? AND id = ?',
  );
  const upMs = db.prepare(
    `INSERT INTO manuscripts (user_id, id, data, last_modified, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_id, id) DO UPDATE SET
       data          = excluded.data,
       last_modified = excluded.last_modified,
       deleted_at    = excluded.deleted_at,
       revision      = manuscripts.revision + 1`,
  );
  const scrubRetainedMs = db.prepare(
    'UPDATE manuscripts SET data = ? WHERE user_id = ? AND id = ?',
  );
  const scrubRetainedMsChapters = db.prepare(`
    UPDATE chapters SET title = NULL, content = NULL, position = NULL
    WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NOT NULL
  `);

  const getCh = db.prepare(
    `SELECT last_modified, deleted_at, revision FROM chapters
      WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
  );
  const hasActiveManuscript = db.prepare(
    'SELECT 1 FROM manuscripts WHERE user_id = ? AND id = ? AND deleted_at IS NULL',
  );
  const getActiveChapters = db.prepare(
    `SELECT id, revision FROM chapters
      WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NULL`,
  );
  const tombstoneChapter = db.prepare(
    `UPDATE chapters
        SET title = NULL, content = NULL, position = NULL,
            last_modified = ?, deleted_at = ?, revision = ?
      WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
  );
  const upCh = db.prepare(
    `INSERT INTO chapters
       (user_id, manuscript_id, id, title, content, position, last_modified, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_id, manuscript_id, id) DO UPDATE SET
       title         = excluded.title,
       content       = excluded.content,
       position      = excluded.position,
       last_modified = excluded.last_modified,
       deleted_at    = excluded.deleted_at,
       revision      = chapters.revision + 1`,
  );
  const scrubRetainedCh = db.prepare(`
    UPDATE chapters SET title = NULL, content = NULL, position = NULL
    WHERE user_id = ? AND manuscript_id = ? AND id = ?
  `);

  const getProfile = db.prepare(
    'SELECT last_modified, revision FROM profiles WHERE user_id = ?',
  );
  const upProfile = db.prepare(
    `INSERT INTO profiles (user_id, data, last_modified, revision)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id) DO UPDATE SET
       data          = excluded.data,
       last_modified = excluded.last_modified,
       revision      = profiles.revision + 1`,
  );

  const getPlugin = db.prepare(
    'SELECT last_modified FROM plugin_states WHERE user_id = ? AND id = ?',
  );
  const upPlugin = db.prepare(
    `INSERT INTO plugin_states (user_id, id, plugin_id, manuscript_id, enabled, state, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       plugin_id     = excluded.plugin_id,
       manuscript_id = excluded.manuscript_id,
       enabled       = excluded.enabled,
       state         = excluded.state,
       last_modified = excluded.last_modified`,
  );

  const apply = db.transaction(() => {
    // ---- manuscripts ----
    for (const m of push.manuscripts) {
      const existing = getMs.get(userId, m.id) as {
        last_modified: number;
        deleted_at: number | null;
        revision: number;
      } | undefined;
      // Retained tombstones are terminal for this legacy LWW protocol. An
      // offline client's future/fast clock must never resurrect a deleted id.
      if (existing && existing.deleted_at !== null) {
        scrubRetainedMs.run(manuscriptTombstoneData(m.id), userId, m.id);
        scrubRetainedMsChapters.run(userId, m.id);
        purgeManuscriptCollaborationResidue(userId, m.id);
        continue;
      }
      if (!existing || m.last_modified > existing.last_modified) {
        const data = m.deleted ? manuscriptTombstoneData(m.id) : m.data;
        upMs.run(userId, m.id, data, m.last_modified, m.deleted ? m.last_modified : null);
        const revision = (existing?.revision ?? 0) + 1;
        recordChange(userId, 'manuscript', null, m.id, m.deleted ? 'delete' : 'upsert', revision);

        if (m.deleted) {
          purgeManuscriptCollaborationResidue(userId, m.id);
          enqueueManuscriptReplicaTombstone(userId, m.id, m.last_modified, revision);
          const chapters = getActiveChapters.all(userId, m.id) as Array<{
            id: string;
            revision: number;
          }>;
          for (const chapter of chapters) {
            const chapterRevision = chapter.revision + 1;
            tombstoneChapter.run(
              m.last_modified,
              m.last_modified,
              chapterRevision,
              userId,
              m.id,
              chapter.id,
            );
            recordChange(
              userId,
              'chapter',
              m.id,
              chapter.id,
              'delete',
              chapterRevision,
            );
            enqueueChapterReplicaTombstone(
              userId,
              m.id,
              chapter.id,
              m.last_modified,
              chapterRevision,
            );
          }
        } else {
          enqueueManuscriptReplica(userId, m.id, m.data, m.last_modified, revision);
        }

      }
    }

    // ---- chapters ----
    for (const c of push.chapters) {
      const existing = getCh.get(userId, c.manuscript_id, c.id) as
        | { last_modified: number; deleted_at: number | null; revision: number }
        | undefined;
      // Never create an orphan or resurrect a chapter beneath a manuscript
      // tombstoned earlier in this batch. A delete for an unknown chapter is
      // already converged and needs no row of its own.
      if (!c.deleted && !hasActiveManuscript.get(userId, c.manuscript_id)) continue;
      if (c.deleted && !existing) continue;
      if (existing && existing.deleted_at !== null) {
        scrubRetainedCh.run(userId, c.manuscript_id, c.id);
        purgeChapterCollaborationResidue(userId, c.manuscript_id, c.id);
        continue;
      }
      if (!existing || c.last_modified > existing.last_modified) {
        upCh.run(
          userId,
          c.manuscript_id,
          c.id,
          c.deleted ? null : (c.title ?? null),
          c.deleted ? null : (c.content ?? null),
          c.deleted ? null : (c.position ?? null),
          c.last_modified,
          c.deleted ? c.last_modified : null,
        );
        const revision = (existing?.revision ?? 0) + 1;
        recordChange(userId, 'chapter', c.manuscript_id, c.id, c.deleted ? 'delete' : 'upsert', revision);

        if (c.deleted) {
          purgeChapterCollaborationResidue(userId, c.manuscript_id, c.id);
          enqueueChapterReplicaTombstone(
            userId,
            c.manuscript_id,
            c.id,
            c.last_modified,
            revision,
          );
        } else {
          enqueueChapterReplica(
            userId,
            c.manuscript_id,
            c.id,
            c.title ?? '',
            c.content ?? '',
            c.position ?? 0,
            c.last_modified,
            revision,
          );
        }
        touchManuscriptForChapterChange(userId, c.manuscript_id, c.last_modified);

      }
    }

    // ---- profile ----
    if (push.profile) {
      const existing = getProfile.get(userId) as
        | { last_modified: number; revision: number }
        | undefined;
      if (!existing || push.profile.last_modified > existing.last_modified) {
        upProfile.run(userId, push.profile.data, push.profile.last_modified);
        const revision = (existing?.revision ?? 0) + 1;
        recordChange(userId, 'profile', null, 'profile', 'upsert', revision);
        enqueueProfileReplica(
          userId,
          push.profile.data,
          push.profile.last_modified,
          revision,
        );
      }
    }

    // ---- plugins ----
    for (const p of push.plugins) {
      const existing = getPlugin.get(userId, p.id) as { last_modified: number } | undefined;
      if (!existing || p.last_modified > existing.last_modified) {
        upPlugin.run(
          userId,
          p.id,
          p.plugin_id,
          p.manuscript_id ?? null,
          p.enabled ? 1 : 0,
          p.state,
          p.last_modified,
        );
      }
    }
  });

  try {
    apply();
  } catch (err) {
    console.error('Sync transaction failed:', err);
    res.status(500).json({ error: 'Sync failed' });
    return;
  }

  // ---- pull: everything newer than `since`, minus what the client just pushed ----
  const manuscriptsOut = (
    db
      .prepare(
        `SELECT id, data, last_modified, deleted_at FROM manuscripts
          WHERE user_id = ? AND last_modified > ?`,
      )
      .all(userId, since) as Array<{
      id: string;
      data: string;
      last_modified: number;
      deleted_at: number | null;
    }>
  ).map((r) => ({
      id: r.id,
      data: r.data,
      last_modified: r.last_modified,
      deleted: !!r.deleted_at,
    }));

  const chaptersOut = (
    db
      .prepare(
        `SELECT id, manuscript_id, title, content, position, last_modified, deleted_at
           FROM chapters
          WHERE user_id = ? AND last_modified > ?`,
      )
      .all(userId, since) as Array<{
      id: string;
      manuscript_id: string;
      title: string | null;
      content: string | null;
      position: number | null;
      last_modified: number;
      deleted_at: number | null;
    }>
  ).map((r) => ({
      id: r.id,
      manuscript_id: r.manuscript_id,
      title: r.title,
      content: r.content,
      position: r.position,
      last_modified: r.last_modified,
      deleted: !!r.deleted_at,
    }));

  let profileOut: { data: string; last_modified: number } | null = null;
  const profileRow = db
    .prepare(
      'SELECT data, last_modified FROM profiles WHERE user_id = ? AND last_modified > ?',
    )
    .get(userId, since) as { data: string; last_modified: number } | undefined;
  if (profileRow) profileOut = profileRow;

  const pluginsOut = (
    db
      .prepare(
        `SELECT id, plugin_id, manuscript_id, enabled, state, last_modified 
           FROM plugin_states
          WHERE user_id = ? AND last_modified > ?`,
      )
      .all(userId, since) as Array<{
      id: string;
      plugin_id: string;
      manuscript_id: string | null;
      enabled: number;
      state: string;
      last_modified: number;
    }>
  ).map((r) => ({
      id: r.id,
      plugin_id: r.plugin_id,
      manuscript_id: r.manuscript_id,
      enabled: !!r.enabled,
      state: r.state,
      last_modified: r.last_modified,
    }));

  res.json({
    serverTime,
    pull: {
      manuscripts: manuscriptsOut,
      chapters: chaptersOut,
      profile: profileOut,
      plugins: pluginsOut,
    },
  });
});

// ---------------------------------------------------------------------------
// Sync v2 — server cursor + per-record optimistic revisions
// ---------------------------------------------------------------------------

const V2ManuscriptChange = z.discriminatedUnion('operation', [
  z.object({
    entity: z.literal('manuscript'),
    operation: z.literal('upsert'),
    id: z.string().min(1).max(64),
    baseRevision: z.number().int().nonnegative(),
    data: z.string().max(50_000).refine((value) => {
      try {
        const parsed = JSON.parse(value);
        return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      } catch {
        return false;
      }
    }, 'data must be a JSON object'),
  }),
  z.object({
    entity: z.literal('manuscript'),
    operation: z.literal('delete'),
    id: z.string().min(1).max(64),
    baseRevision: z.number().int().positive(),
  }),
]);

const V2ChapterChange = z.discriminatedUnion('operation', [
  z.object({
    entity: z.literal('chapter'),
    operation: z.literal('upsert'),
    manuscriptId: z.string().min(1).max(64),
    id: z.string().min(1).max(64),
    baseRevision: z.number().int().nonnegative(),
    title: z.string().max(500),
    content: z.string().max(5_000_000),
    position: z.number().int().nonnegative(),
  }),
  z.object({
    entity: z.literal('chapter'),
    operation: z.literal('delete'),
    manuscriptId: z.string().min(1).max(64),
    id: z.string().min(1).max(64),
    baseRevision: z.number().int().positive(),
  }),
]);

const V2ProfileChange = z.object({
  entity: z.literal('profile'),
  operation: z.literal('upsert'),
  baseRevision: z.number().int().nonnegative(),
  data: z.string().max(50_000).refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, 'data must be valid JSON'),
});

const SyncV2Body = z.object({
  cursor: z.number().int().nonnegative().default(0),
  epoch: z.string().uuid().optional(),
  changes: z
    .array(z.union([V2ManuscriptChange, V2ChapterChange, V2ProfileChange]))
    .max(2_000)
    .default([]),
});

type V2Input = z.infer<typeof SyncV2Body>['changes'][number];
type V2Result = {
  entity: V2Input['entity'];
  id: string;
  manuscriptId?: string;
  status: 'accepted' | 'conflict';
  /** Present when a matching record revision was rejected for protocol state. */
  reason?: 'history_epoch_mismatch' | 'cursor_ahead_of_history';
  revision: number;
  current?: unknown;
};

function v2Key(change: V2Input): { id: string; manuscriptId?: string } {
  if (change.entity === 'profile') return { id: 'profile' };
  if (change.entity === 'chapter') {
    return { id: change.id, manuscriptId: change.manuscriptId };
  }
  return { id: change.id };
}

function currentV2Record(
  userId: string,
  entity: 'manuscript' | 'chapter' | 'profile',
  id: string,
  manuscriptId?: string | null,
): { revision: number; value: unknown } | null {
  if (entity === 'manuscript') {
    const row = db
      .prepare(
        `SELECT data, last_modified, deleted_at, revision
           FROM manuscripts WHERE user_id = ? AND id = ?`,
      )
      .get(userId, id) as
      | { data: string; last_modified: number; deleted_at: number | null; revision: number }
      | undefined;
    if (!row) return null;
    if (row.deleted_at !== null) {
      return {
        revision: row.revision,
        value: {
          entity,
          id,
          operation: 'delete',
          revision: row.revision,
          updatedAt: row.last_modified,
        },
      };
    }
    return {
      revision: row.revision,
      value: {
        entity,
        id,
        operation: 'upsert',
        data: row.data,
        revision: row.revision,
        updatedAt: row.last_modified,
      },
    };
  }
  if (entity === 'chapter') {
    const row = db
      .prepare(
        `SELECT title, content, position, last_modified, deleted_at, revision
           FROM chapters
          WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
      )
      .get(userId, manuscriptId, id) as
      | {
          title: string | null;
          content: string | null;
          position: number | null;
          last_modified: number;
          deleted_at: number | null;
          revision: number;
        }
      | undefined;
    if (!row) return null;
    if (row.deleted_at !== null) {
      return {
        revision: row.revision,
        value: {
          entity,
          manuscriptId,
          id,
          operation: 'delete',
          revision: row.revision,
          updatedAt: row.last_modified,
        },
      };
    }
    return {
      revision: row.revision,
      value: {
        entity,
        manuscriptId,
        id,
        operation: 'upsert',
        title: row.title,
        content: row.content,
        position: row.position,
        revision: row.revision,
        updatedAt: row.last_modified,
      },
    };
  }
  const row = db
    .prepare('SELECT data, last_modified, revision FROM profiles WHERE user_id = ?')
    .get(userId) as { data: string; last_modified: number; revision: number } | undefined;
  if (!row) return null;
  return {
    revision: row.revision,
    value: {
      entity,
      id: 'profile',
      operation: 'upsert',
      data: row.data,
      revision: row.revision,
      updatedAt: row.last_modified,
    },
  };
}

router.post('/v2', (req, res) => {
  const parsed = SyncV2Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid sync v2 payload', details: parsed.error.flatten() });
    return;
  }

  const userId = req.userId!;
  let historyResetRequired = false;
  const results: V2Result[] = [];
  const apply = db.transaction(() => {
    const transactionEpoch = getSyncHistoryEpoch();
    const preMutationMaxCursor = ((db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log WHERE user_id = ?')
      .get(userId) as { seq: number }).seq ?? 0);
    // A revision token is meaningful only within the history that issued it.
    // Validate both reset signals inside the same immediate transaction that
    // would apply writes. This serializes a concurrent restore process and
    // prevents an incoming write from advancing MAX(seq) enough to hide the
    // numeric compatibility reset that existed when the request arrived.
    const resetReason: V2Result['reason'] = (
      parsed.data.epoch !== undefined && parsed.data.epoch !== transactionEpoch
    )
      ? 'history_epoch_mismatch'
      : parsed.data.cursor > preMutationMaxCursor
        ? 'cursor_ahead_of_history'
        : undefined;
    historyResetRequired = resetReason !== undefined;
    if (historyResetRequired) {
      // Keep the normal push+pull envelope so clients can consume the reset
      // replay in this round trip. Every attempted mutation is an explicit
      // conflict with the authoritative record; none reaches the mutation
      // loop, change log, or recovery-replica outbox.
      for (const incoming of parsed.data.changes) {
        const key = v2Key(incoming);
        const current = currentV2Record(
          userId,
          incoming.entity,
          key.id,
          key.manuscriptId,
        );
        results.push({
          entity: incoming.entity,
          ...key,
          status: 'conflict',
          reason: resetReason,
          revision: current?.revision ?? 0,
          current: current?.value ?? null,
        });
      }
      return transactionEpoch;
    }

    for (const incoming of parsed.data.changes) {
      const key = v2Key(incoming);
      const current = currentV2Record(
        userId,
        incoming.entity,
        key.id,
        key.manuscriptId,
      );
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== incoming.baseRevision) {
        results.push({
          entity: incoming.entity,
          ...key,
          status: 'conflict',
          revision: currentRevision,
          current: current?.value ?? null,
        });
        continue;
      }

      const revision = currentRevision + 1;
      const now = Date.now();
      if (incoming.entity === 'manuscript') {
        if (incoming.operation === 'upsert') {
          db.prepare(
            `INSERT INTO manuscripts
              (user_id, id, data, last_modified, deleted_at, revision)
             VALUES (?, ?, ?, ?, NULL, ?)
             ON CONFLICT(user_id, id) DO UPDATE SET
               data = excluded.data,
               last_modified = excluded.last_modified,
               deleted_at = NULL,
               revision = excluded.revision`,
          ).run(userId, incoming.id, incoming.data, now, revision);
          enqueueManuscriptReplica(
            userId,
            incoming.id,
            incoming.data,
            now,
            revision,
          );
        } else {
          db.prepare(
            `UPDATE manuscripts
                SET data = ?, deleted_at = ?, last_modified = ?, revision = ?
              WHERE user_id = ? AND id = ?`,
          ).run(
            manuscriptTombstoneData(incoming.id),
            now,
            now,
            revision,
            userId,
            incoming.id,
          );
          purgeManuscriptCollaborationResidue(userId, incoming.id);
          enqueueManuscriptReplicaTombstone(userId, incoming.id, now, revision);

          const chapters = db
            .prepare(
              `SELECT id, revision FROM chapters
                WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NULL`,
            )
            .all(userId, incoming.id) as Array<{ id: string; revision: number }>;
          const tombstone = db.prepare(
            `UPDATE chapters
                SET title = NULL, content = NULL, position = NULL,
                    deleted_at = ?, last_modified = ?, revision = ?
              WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
          );
          for (const chapter of chapters) {
            const chapterRevision = chapter.revision + 1;
            tombstone.run(
              now,
              now,
              chapterRevision,
              userId,
              incoming.id,
              chapter.id,
            );
            recordChange(
              userId,
              'chapter',
              incoming.id,
              chapter.id,
              'delete',
              chapterRevision,
              now,
            );
            enqueueChapterReplicaTombstone(
              userId,
              incoming.id,
              chapter.id,
              now,
              chapterRevision,
            );
          }
        }
        recordChange(
          userId,
          'manuscript',
          null,
          incoming.id,
          incoming.operation,
          revision,
          now,
        );
      } else if (incoming.entity === 'chapter') {
        if (incoming.operation === 'upsert') {
          const parent = db
            .prepare(
              'SELECT 1 FROM manuscripts WHERE user_id = ? AND id = ? AND deleted_at IS NULL',
            )
            .get(userId, incoming.manuscriptId);
          if (!parent) {
            results.push({
              entity: 'chapter',
              ...key,
              status: 'conflict',
              revision: currentRevision,
              current: null,
            });
            continue;
          }
          db.prepare(
            `INSERT INTO chapters
              (user_id, manuscript_id, id, title, content, position,
               last_modified, deleted_at, revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
             ON CONFLICT(user_id, manuscript_id, id) DO UPDATE SET
               title = excluded.title,
               content = excluded.content,
               position = excluded.position,
               last_modified = excluded.last_modified,
               deleted_at = NULL,
               revision = excluded.revision`,
          ).run(
            userId,
            incoming.manuscriptId,
            incoming.id,
            incoming.title,
            incoming.content,
            incoming.position,
            now,
            revision,
          );
          enqueueChapterReplica(
            userId,
            incoming.manuscriptId,
            incoming.id,
            incoming.title,
            incoming.content,
            incoming.position,
            now,
            revision,
          );
        } else {
          db.prepare(
            `UPDATE chapters
                SET title = NULL, content = NULL, position = NULL,
                    deleted_at = ?, last_modified = ?, revision = ?
              WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
          ).run(now, now, revision, userId, incoming.manuscriptId, incoming.id);
          purgeChapterCollaborationResidue(
            userId,
            incoming.manuscriptId,
            incoming.id,
          );
          enqueueChapterReplicaTombstone(
            userId,
            incoming.manuscriptId,
            incoming.id,
            now,
            revision,
          );
        }
        recordChange(
          userId,
          'chapter',
          incoming.manuscriptId,
          incoming.id,
          incoming.operation,
          revision,
          now,
        );
        touchManuscriptForChapterChange(userId, incoming.manuscriptId, now);
      } else {
        db.prepare(
          `INSERT INTO profiles (user_id, data, last_modified, revision)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             data = excluded.data,
             last_modified = excluded.last_modified,
             revision = excluded.revision`,
        ).run(userId, incoming.data, now, revision);
        recordChange(userId, 'profile', null, 'profile', 'upsert', revision, now);
        enqueueProfileReplica(userId, incoming.data, now, revision);
      }

      results.push({
        entity: incoming.entity,
        ...key,
        status: 'accepted',
        revision,
      });
    }
    return transactionEpoch;
  });

  let epoch: string;
  try {
    // Pull-only browser polling stays a read transaction; requests carrying
    // mutations acquire the write reservation before validating the epoch.
    epoch = parsed.data.changes.length > 0 ? apply.immediate() : apply();
  } catch (error) {
    console.error('Sync v2 transaction failed:', error);
    res.status(500).json({ error: 'Sync failed' });
    return;
  }

  // A later mutation in the same batch can advance a record that an earlier
  // result referred to. In particular, a chapter mutation also advances its
  // aggregate manuscript revision. Return only final authoritative tokens so
  // clients never persist a revision that is already stale on receipt.
  for (const result of results) {
    const current = currentV2Record(
      userId,
      result.entity,
      result.id,
      result.manuscriptId,
    );
    result.revision = current?.revision ?? 0;
    if (result.status === 'conflict') result.current = current?.value ?? null;
  }

  const pageSize = 1_000;
  const currentMaxCursor = ((db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log WHERE user_id = ?')
    .get(userId) as { seq: number }).seq ?? 0);
  // Epoch mismatch is the durable restore signal. The max-cursor check remains
  // as a compatibility fallback for clients that have not learned an epoch or
  // for an older database snapshot that predates the epoch marker.
  const reset = historyResetRequired;
  const pullCursor = reset ? 0 : parsed.data.cursor;
  const fetchedLogRows = db
    .prepare(
      `SELECT seq, entity, manuscript_id, record_id
         FROM change_log
        WHERE user_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?`,
    )
    .all(userId, pullCursor, pageSize + 1) as Array<{
    seq: number;
    entity: 'manuscript' | 'chapter' | 'profile';
    manuscript_id: string | null;
    record_id: string;
  }>;
  const hasMore = fetchedLogRows.length > pageSize;
  const logRows = hasMore ? fetchedLogRows.slice(0, pageSize) : fetchedLogRows;

  // Multiple mutations to one record collapse to its latest authoritative
  // representation, while the response cursor still advances past all of them.
  const latest = new Map<string, (typeof logRows)[number]>();
  for (const row of logRows) {
    latest.set(`${row.entity}\0${row.manuscript_id ?? ''}\0${row.record_id}`, row);
  }
  const changes = [...latest.values()]
    .map((row) =>
      currentV2Record(userId, row.entity, row.record_id, row.manuscript_id)?.value ?? null,
    )
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const cursor = logRows.length
    ? logRows[logRows.length - 1].seq
    : currentMaxCursor;

  res.json({
    epoch,
    cursor,
    results,
    changes,
    hasMore,
    ...(reset ? { reset: true } : {}),
  });
});

export default router;
