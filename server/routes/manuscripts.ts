import { Router } from 'express';
import { z } from 'zod';
import {
  deleteChapter,
  deleteManuscript,
  listManuscripts,
  loadManuscript,
  saveLegacyManuscript,
  type ManuscriptRecord,
} from '../lib/manuscriptRepository';

const router = Router();

/**
 * Backward-compatible manuscript CRUD.
 *
 * The payload is still the web/mobile Manuscript shape, but persistence is
 * record-aware: metadata and each chapter carry independent revisions. Missing
 * chapters are never interpreted as deletes; deletion has an explicit endpoint.
 */

const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const Chapter = z.object({
  id: Id,
  title: z.string().max(500),
  content: z.string().max(5_000_000),
  lastModified: z.number().int().nonnegative(),
  revision: z.number().int().positive().optional(),
});
const Metadata = z
  .object({
    id: Id,
    title: z.string().max(1_000),
    author: z.string().max(1_000),
    lastModified: z.number().int().nonnegative(),
    revision: z.number().int().positive().optional(),
  })
  .passthrough();
const ManuscriptBody = z.object({
  metadata: Metadata,
  chapters: z.array(Chapter).max(10_000),
});
const DeleteChapterBody = z
  .object({ baseRevision: z.number().int().positive().optional() })
  .default({});
const DeleteManuscriptBody = DeleteChapterBody;

function parseManuscript(body: unknown): ManuscriptRecord {
  const parsed = ManuscriptBody.safeParse(body);
  if (!parsed.success) {
    const error = new Error('Invalid manuscript payload');
    Object.assign(error, { status: 400, details: parsed.error.flatten() });
    throw error;
  }
  return parsed.data as ManuscriptRecord;
}

router.get('/', (req, res) => {
  res.json(listManuscripts(req.userId!));
});

router.get('/:id', (req, res) => {
  const manuscript = loadManuscript(req.userId!, req.params.id);
  if (!manuscript) {
    res.status(404).json({ error: 'Manuscript not found' });
    return;
  }
  res.json(manuscript);
});

router.post('/', (req, res) => {
  try {
    const manuscript = parseManuscript(req.body);
    const result = saveLegacyManuscript(req.userId!, manuscript, { createOnly: true });
    if (result.conflicts.length) {
      res.status(409).json({
        error: 'A manuscript with this id already exists',
        manuscript: result.manuscript,
        conflicts: result.conflicts,
      });
      return;
    }
    if (!result.manuscript) throw new Error('Manuscript was not created');
    res.status(201).json(result.manuscript);
  } catch (error) {
    const typed = error as Error & { status?: number; details?: unknown };
    res.status(typed.status ?? 400).json({ error: typed.message, details: typed.details });
  }
});

router.put('/:id', (req, res) => {
  try {
    const manuscript = parseManuscript(req.body);
    manuscript.metadata.id = req.params.id;
    const result = saveLegacyManuscript(req.userId!, manuscript);
    if (result.conflicts.length) {
      res.status(409).json({
        error: 'The manuscript changed on another device',
        manuscript: result.manuscript,
        conflicts: result.conflicts,
      });
      return;
    }
    if (!result.manuscript) throw new Error('Manuscript was not saved');
    res.json(result.manuscript);
  } catch (error) {
    const typed = error as Error & { status?: number; details?: unknown };
    res.status(typed.status ?? 400).json({ error: typed.message, details: typed.details });
  }
});

router.delete('/:manuscriptId/chapters/:chapterId', (req, res) => {
  const parsed = DeleteChapterBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid chapter delete payload' });
    return;
  }
  const result = deleteChapter(
    req.userId!,
    req.params.manuscriptId,
    req.params.chapterId,
    parsed.data.baseRevision,
  );
  if (!result) {
    res.status(404).json({ error: 'Chapter not found' });
    return;
  }
  if (result.ok === false) {
    res.status(409).json({
      error: 'The chapter changed on another device',
      currentRevision: result.currentRevision,
    });
    return;
  }
  res.json({
    ok: true,
    revision: result.revision,
    manuscriptRevision: result.manuscriptRevision,
  });
});

router.delete('/:id', (req, res) => {
  const parsed = DeleteManuscriptBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid manuscript delete payload' });
    return;
  }
  const result = deleteManuscript(
    req.userId!,
    req.params.id,
    parsed.data.baseRevision,
  );
  if (!result) {
    res.status(404).json({ error: 'Manuscript not found' });
    return;
  }
  if (result.ok === false) {
    res.status(409).json({
      error: 'The manuscript changed on another device',
      currentRevision: result.currentRevision,
    });
    return;
  }
  res.status(204).send();
});

export default router;
