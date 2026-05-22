import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { config } from '../config';
import { ncMirror } from '../nextcloud/webdav';
import { storage } from '../lib/storage/HybridManager';

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
 * propagates to other clients on their next pull. They're GC'd after
 * config.tombstoneRetentionMs (default 30 days), which is plenty of time
 * for any reasonable client offline window.
 *
 * Echo avoidance: records the client just pushed aren't returned in pull,
 * so the client doesn't see its own write bounce back.
 */

const ManuscriptIn = z.object({
  id: z.string().min(1).max(64),
  data: z.string().max(50_000),
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
  data: z.string().max(50_000),
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

router.post('/sync', (req, res) => {
  const parsed = SyncBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid sync payload', details: parsed.error.flatten() });
    return;
  }

  const { since, push } = parsed.data;
  const userId = req.userId!;
  const serverTime = Date.now();

  // Track keys the client pushed so we don't echo them back in pull.
  const pushedManuscriptIds = new Set(push.manuscripts.map((m) => m.id));
  const pushedChapterKeys = new Set(push.chapters.map((c) => `${c.manuscript_id}:${c.id}`));
  const pushedPluginIds = new Set(push.plugins.map((p) => p.id));
  const profilePushed = !!push.profile;

  // Collect mirror jobs to run *after* the transaction commits.
  type MirrorJob = () => Promise<void>;
  const mirrorJobs: MirrorJob[] = [];

  const getMs = db.prepare(
    'SELECT last_modified FROM manuscripts WHERE user_id = ? AND id = ?',
  );
  const upMs = db.prepare(
    `INSERT INTO manuscripts (user_id, id, data, last_modified, deleted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       data          = excluded.data,
       last_modified = excluded.last_modified,
       deleted_at    = excluded.deleted_at`,
  );

  const getCh = db.prepare(
    'SELECT last_modified FROM chapters WHERE user_id = ? AND manuscript_id = ? AND id = ?',
  );
  const upCh = db.prepare(
    `INSERT INTO chapters
       (user_id, manuscript_id, id, title, content, position, last_modified, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, manuscript_id, id) DO UPDATE SET
       title         = excluded.title,
       content       = excluded.content,
       position      = excluded.position,
       last_modified = excluded.last_modified,
       deleted_at    = excluded.deleted_at`,
  );

  const getProfile = db.prepare(
    'SELECT last_modified FROM profiles WHERE user_id = ?',
  );
  const upProfile = db.prepare(
    `INSERT INTO profiles (user_id, data, last_modified)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       data          = excluded.data,
       last_modified = excluded.last_modified`,
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
      const existing = getMs.get(userId, m.id) as { last_modified: number } | undefined;
      if (!existing || m.last_modified > existing.last_modified) {
        upMs.run(userId, m.id, m.data, m.last_modified, m.deleted ? m.last_modified : null);
        
        // Redundant Backup (Hybrid Storage)
        if (config.storageProvider === 'hybrid') {
          const key = `manuscripts/${userId}/${m.id}/manuscript.json`;
          if (m.deleted) {
            mirrorJobs.push(() => storage.delete(`manuscripts/${userId}/${m.id}`));
          } else {
            mirrorJobs.push(() => storage.put(key, m.data, 'application/json'));
          }
        }

        if (config.nextcloud.mirrorEnabled) {
          if (m.deleted) {
            mirrorJobs.push(() => ncMirror.deleteManuscript(userId, m.id));
          } else {
            mirrorJobs.push(() => ncMirror.manuscript(userId, m.id, m.data));
          }
        }
      }
    }

    // ---- chapters ----
    for (const c of push.chapters) {
      const existing = getCh.get(userId, c.manuscript_id, c.id) as
        | { last_modified: number }
        | undefined;
      if (!existing || c.last_modified > existing.last_modified) {
        upCh.run(
          userId,
          c.manuscript_id,
          c.id,
          c.title ?? null,
          c.content ?? null,
          c.position ?? null,
          c.last_modified,
          c.deleted ? c.last_modified : null,
        );

        // Redundant Backup (Hybrid Storage)
        if (config.storageProvider === 'hybrid') {
          const key = `manuscripts/${userId}/${c.manuscript_id}/chapters/${c.id}.html`;
          if (c.deleted) {
            mirrorJobs.push(() => storage.delete(key));
          } else {
            const wrapped = `<!DOCTYPE html><html><body><h1>${c.title || 'Untitled'}</h1>${c.content || ''}</body></html>`;
            mirrorJobs.push(() => storage.put(key, wrapped, 'text/html'));
          }
        }

        if (config.nextcloud.mirrorEnabled) {
          if (c.deleted) {
            mirrorJobs.push(() => ncMirror.deleteChapter(userId, c.manuscript_id, c.id));
          } else {
            mirrorJobs.push(() =>
              ncMirror.chapter(
                userId,
                c.manuscript_id,
                c.id,
                c.title ?? '',
                c.content ?? '',
              ),
            );
          }
        }
      }
    }

    // ---- profile ----
    if (push.profile) {
      const existing = getProfile.get(userId) as
        | { last_modified: number }
        | undefined;
      if (!existing || push.profile.last_modified > existing.last_modified) {
        upProfile.run(userId, push.profile.data, push.profile.last_modified);
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
  )
    .filter((r) => !pushedManuscriptIds.has(r.id))
    .map((r) => ({
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
  )
    .filter((r) => !pushedChapterKeys.has(`${r.manuscript_id}:${r.id}`))
    .map((r) => ({
      id: r.id,
      manuscript_id: r.manuscript_id,
      title: r.title,
      content: r.content,
      position: r.position,
      last_modified: r.last_modified,
      deleted: !!r.deleted_at,
    }));

  let profileOut: { data: string; last_modified: number } | null = null;
  if (!profilePushed) {
    const row = db
      .prepare(
        'SELECT data, last_modified FROM profiles WHERE user_id = ? AND last_modified > ?',
      )
      .get(userId, since) as { data: string; last_modified: number } | undefined;
    if (row) profileOut = row;
  }

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
  )
    .filter((r) => !pushedPluginIds.has(r.id))
    .map((r) => ({
      id: r.id,
      plugin_id: r.plugin_id,
      manuscript_id: r.manuscript_id,
      enabled: !!r.enabled,
      state: r.state,
      last_modified: r.last_modified,
    }));

  // Fire-and-forget Nextcloud mirror. Sync response never waits on it.
  if (mirrorJobs.length > 0) {
    Promise.allSettled(mirrorJobs.map((j) => j())).then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') {
          console.warn('NC mirror job failed:', r.reason);
        }
      }
    });
  }

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

export default router;
