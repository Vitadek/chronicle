import { Manuscript, ManuscriptMetadata } from '../types';
import { authFetch } from './authService';

export interface ManuscriptRecordConflict {
  entity: 'manuscript' | 'chapter';
  id: string;
  manuscriptId?: string;
  expectedRevision?: number;
  currentRevision: number;
  reason: 'stale-revision' | 'stale-timestamp' | 'deleted' | 'already-exists';
}

export class ManuscriptServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly authoritativeManuscript: Manuscript | null = null,
    readonly conflicts: ManuscriptRecordConflict[] = [],
  ) {
    super(message);
    this.name = 'ManuscriptServiceError';
  }
}

function isManuscript(value: unknown): value is Manuscript {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Manuscript>;
  return !!candidate.metadata &&
    typeof candidate.metadata === 'object' &&
    typeof candidate.metadata.id === 'string' &&
    Array.isArray(candidate.chapters);
}

function isRecordConflict(value: unknown): value is ManuscriptRecordConflict {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ManuscriptRecordConflict>;
  return (candidate.entity === 'manuscript' || candidate.entity === 'chapter') &&
    typeof candidate.id === 'string' &&
    typeof candidate.currentRevision === 'number' &&
    (
      candidate.reason === 'stale-revision' ||
      candidate.reason === 'stale-timestamp' ||
      candidate.reason === 'deleted' ||
      candidate.reason === 'already-exists'
    );
}

/** Parse structured concurrency details without hiding useful proxy fallbacks. */
export async function manuscriptServiceErrorFromResponse(
  res: Response,
  fallback: string,
): Promise<ManuscriptServiceError> {
  let message = fallback;
  let authoritativeManuscript: Manuscript | null = null;
  let conflicts: ManuscriptRecordConflict[] = [];
  try {
    const body = await res.json() as {
      error?: unknown;
      message?: unknown;
      manuscript?: unknown;
      conflicts?: unknown;
    };
    if (typeof body.error === 'string') message = body.error;
    else if (typeof body.message === 'string') message = body.message;
    if (isManuscript(body.manuscript)) authoritativeManuscript = body.manuscript;
    if (Array.isArray(body.conflicts)) conflicts = body.conflicts.filter(isRecordConflict);
  } catch {
    // An HTML/plain-text proxy response should not hide the useful fallback.
  }
  return new ManuscriptServiceError(
    message,
    res.status,
    authoritativeManuscript,
    conflicts,
  );
}

export const manuscriptService = {
  async list(): Promise<ManuscriptMetadata[]> {
    const res = await authFetch('/api/manuscripts');
    if (!res.ok) throw new Error('Failed to list manuscripts');
    return res.json();
  },

  async get(id: string, signal?: AbortSignal): Promise<Manuscript> {
    const res = await authFetch(`/api/manuscripts/${id}`, { signal });
    if (!res.ok) throw await manuscriptServiceErrorFromResponse(res, 'Manuscript not found');
    return res.json();
  },

  async create(manuscript: Manuscript): Promise<Manuscript> {
    const res = await authFetch('/api/manuscripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manuscript),
    });
    if (!res.ok) throw await manuscriptServiceErrorFromResponse(res, 'Failed to create manuscript');
    return res.json();
  },

  async update(id: string, manuscript: Manuscript): Promise<Manuscript> {
    const res = await authFetch(`/api/manuscripts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manuscript),
    });
    if (!res.ok) throw await manuscriptServiceErrorFromResponse(res, 'Failed to save manuscript');
    return res.json();
  },

  /**
   * Delete one chapter explicitly. Whole-manuscript PUT intentionally does
   * not infer deletion from an omitted chapter because an older client could
   * otherwise tombstone a newer chapter set.
   */
  async deleteChapter(
    manuscriptId: string,
    chapterId: string,
    baseRevision?: number,
  ): Promise<{ revision: number; manuscriptRevision?: number }> {
    const res = await authFetch(
      `/api/manuscripts/${encodeURIComponent(manuscriptId)}/chapters/${encodeURIComponent(chapterId)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevision }),
      },
    );
    if (!res.ok) throw await manuscriptServiceErrorFromResponse(res, 'Failed to delete chapter');
    return res.json();
  },

  async delete(id: string, baseRevision?: number): Promise<void> {
    const res = await authFetch(`/api/manuscripts/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision }),
    });
    if (!res.ok) throw await manuscriptServiceErrorFromResponse(res, 'Failed to delete manuscript');
  },
};
