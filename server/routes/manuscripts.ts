import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config';
import { db } from '../db';
import { ncMirror } from '../nextcloud/webdav';

const router = Router();

/**
 * Backward-compatible manuscript CRUD.
 *
 * The existing UI uses these endpoints (manuscriptService.ts). To avoid
 * breaking it, we keep them — but they now read/write against the SQLite
 * store that sync uses, so both APIs see the same data. Single source of
 * truth, no dual-store confusion.
 *
 * Going forward, prefer /api/sync from new clients. This module exists for
 * the in-tree UI which hasn't been migrated yet.
 */

interface ChapterJson {
  id: string;
  title: string;
  content: string;
  lastModified: number;
}
interface ManuscriptJson {
  metadata: {
    id: string;
    title: string;
    author: string;
    lastModified: number;
    [k: string]: unknown;
  };
  chapters: ChapterJson[];
}

/** Reassemble a Manuscript JSON object from the normalised SQLite tables. */
function loadManuscript(userId: string, id: string): ManuscriptJson | null {
  const mRow = db
    .prepare(
      'SELECT data, last_modified, deleted_at FROM manuscripts WHERE user_id = ? AND id = ?',
    )
    .get(userId, id) as
    | { data: string; last_modified: number; deleted_at: number | null }
    | undefined;
  if (!mRow || mRow.deleted_at) return null;

  const cRows = db
    .prepare(
      `SELECT id, title, content, position, last_modified
         FROM chapters
        WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NULL
        ORDER BY position ASC, last_modified ASC`,
    )
    .all(userId, id) as Array<{
    id: string;
    title: string | null;
    content: string | null;
    position: number | null;
    last_modified: number;
  }>;

  const metadata = JSON.parse(mRow.data);
  metadata.id = id;
  metadata.lastModified = mRow.last_modified;

  return {
    metadata,
    chapters: cRows.map((c) => ({
      id: c.id,
      title: c.title || '',
      content: c.content || '',
      lastModified: c.last_modified,
    })),
  };
}

/** Persist a Manuscript JSON object into the normalised tables. */
function saveManuscript(userId: string, m: ManuscriptJson): void {
  const mId = m.metadata.id;
  const mLast = m.metadata.lastModified || Date.now();

  // Strip chapter list out of metadata before storing.
  const metaToStore = { ...m.metadata };
  // Remove transient/computed fields we don't want duplicated.
  delete (metaToStore as Record<string, unknown>).chapters;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO manuscripts (user_id, id, data, last_modified, deleted_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(user_id, id) DO UPDATE SET
         data = excluded.data,
         last_modified = excluded.last_modified,
         deleted_at = NULL`,
    ).run(userId, mId, JSON.stringify(metaToStore), mLast);

    // Replace chapter set: upsert what's here, soft-delete what's missing.
    const incomingIds = new Set(m.chapters.map((c) => c.id));
    const upCh = db.prepare(
      `INSERT INTO chapters
         (user_id, manuscript_id, id, title, content, position, last_modified, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(user_id, manuscript_id, id) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         position = excluded.position,
         last_modified = excluded.last_modified,
         deleted_at = NULL`,
    );
    m.chapters.forEach((c, idx) => {
      upCh.run(
        userId,
        mId,
        c.id,
        c.title,
        c.content,
        idx,
        c.lastModified || Date.now(),
      );
    });

    // Tombstone any chapters this manuscript no longer contains.
    const existing = db
      .prepare(
        'SELECT id FROM chapters WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NULL',
      )
      .all(userId, mId) as Array<{ id: string }>;
    const now = Date.now();
    for (const row of existing) {
      if (!incomingIds.has(row.id)) {
        db.prepare(
          `UPDATE chapters SET deleted_at = ?, last_modified = ?
            WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
        ).run(now, now, userId, mId, row.id);
      }
    }
  });
  tx();

  // Best-effort Nextcloud mirror.
  if (config.nextcloud.mirrorEnabled) {
    Promise.allSettled([
      ncMirror.manuscript(userId, mId, JSON.stringify(metaToStore)),
      ...m.chapters.map((c) =>
        ncMirror.chapter(userId, mId, c.id, c.title, c.content),
      ),
    ]).catch(() => {});
  }
}

router.get('/', (req, res) => {
  const userId = req.userId!;
  const rows = db
    .prepare(
      `SELECT id, data, last_modified FROM manuscripts
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY last_modified DESC`,
    )
    .all(userId) as Array<{ id: string; data: string; last_modified: number }>;

  res.json(
    rows.map((r) => {
      const meta = JSON.parse(r.data);
      meta.id = r.id;
      meta.lastModified = r.last_modified;
      return meta;
    }),
  );
});

router.get('/:id', (req, res) => {
  const m = loadManuscript(req.userId!, req.params.id);
  if (!m) {
    res.status(404).json({ error: 'Manuscript not found' });
    return;
  }
  res.json(m);
});

router.post('/', (req, res) => {
  const userId = req.userId!;
  const m: ManuscriptJson = req.body;
  if (!m?.metadata?.id) {
    m.metadata = {
      ...(m.metadata || ({} as ManuscriptJson['metadata'])),
      id: Math.random().toString(36).slice(2, 11),
      title: m.metadata?.title || 'Untitled',
      author: m.metadata?.author || 'Uncredited Author',
      lastModified: Date.now(),
    };
  }
  saveManuscript(userId, m);
  res.status(201).json(m);
});

router.put('/:id', (req, res) => {
  const userId = req.userId!;
  const m: ManuscriptJson = req.body;
  m.metadata = { ...m.metadata, id: req.params.id };
  saveManuscript(userId, m);
  res.json(m);
});

router.delete('/:id', (req, res) => {
  const userId = req.userId!;
  const id = req.params.id;
  const now = Date.now();
  db.prepare(
    `UPDATE manuscripts SET deleted_at = ?, last_modified = ?
      WHERE user_id = ? AND id = ?`,
  ).run(now, now, userId, id);
  db.prepare(
    `UPDATE chapters SET deleted_at = ?, last_modified = ?
      WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NULL`,
  ).run(now, now, userId, id);

  if (config.nextcloud.mirrorEnabled) {
    ncMirror.deleteManuscript(userId, id).catch(() => {});
  }

  res.status(204).send();
});

export default router;
