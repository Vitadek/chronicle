import type { Manuscript } from '../types';

const DRAFT_PREFIX = 'chronicle_manuscript_draft_';
const CONFLICT_DRAFT_PREFIX = 'chronicle_manuscript_conflict_draft_';
const DRAFT_INDEX_KEY = 'chronicle_manuscript_draft_index_v1';
const MAX_DRAFTS = 5;

export interface ManuscriptDraftRecord {
  version: 1;
  manuscriptId: string;
  updatedAt: number;
  manuscript: Manuscript;
}

function keyFor(manuscriptId: string): string {
  return `${DRAFT_PREFIX}${manuscriptId}`;
}

function conflictKeyFor(manuscriptId: string): string {
  return `${CONFLICT_DRAFT_PREFIX}${manuscriptId}`;
}

function makeRecord(manuscriptId: string, manuscript: Manuscript): ManuscriptDraftRecord {
  return {
    version: 1,
    manuscriptId,
    updatedAt: Date.now(),
    manuscript,
  };
}

function readRecord(key: string, manuscriptId: string): ManuscriptDraftRecord | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<ManuscriptDraftRecord>;
    if (
      record.version !== 1 ||
      record.manuscriptId !== manuscriptId ||
      !record.manuscript ||
      record.manuscript.metadata?.id !== manuscriptId ||
      !Array.isArray(record.manuscript.chapters)
    ) {
      return null;
    }
    return record as ManuscriptDraftRecord;
  } catch {
    return null;
  }
}

/**
 * Browser-local crash journal. The server remains authoritative; this copy is
 * retained only while a save is pending/failed and removed after the exact
 * snapshot has been acknowledged.
 */
export function writeManuscriptDraft(manuscriptId: string, manuscript: Manuscript): boolean {
  const updatedAt = Date.now();
  // Make room before serializing a sixth book; waiting until after setItem can
  // leave quota-bound browsers unable to write the newest (most valuable)
  // recovery snapshot.
  try {
    const rawIndex = localStorage.getItem(DRAFT_INDEX_KEY);
    const parsed = rawIndex ? JSON.parse(rawIndex) as Record<string, unknown> : {};
    if (!(manuscriptId in parsed)) {
      const existing = Object.entries(parsed)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
        .sort((a, b) => b[1] - a[1]);
      for (const [expiredId] of existing.slice(MAX_DRAFTS - 1)) {
        delete parsed[expiredId];
        localStorage.removeItem(keyFor(expiredId));
      }
      localStorage.setItem(DRAFT_INDEX_KEY, JSON.stringify(parsed));
    }
  } catch {
    // The authoritative write below still gets a chance in restricted modes.
  }
  try {
    const record = makeRecord(manuscriptId, manuscript);
    localStorage.setItem(keyFor(manuscriptId), JSON.stringify(record));
  } catch (error) {
    console.warn('Could not write the local manuscript draft journal:', error);
    return false;
  }

  // Keep recovery storage bounded without reparsing up to five full books on
  // every journal flush. Index maintenance is best-effort; the current draft
  // is already durable once the setItem above succeeds.
  try {
    const rawIndex = localStorage.getItem(DRAFT_INDEX_KEY);
    const parsed = rawIndex ? JSON.parse(rawIndex) as unknown : {};
    const index: Record<string, number> =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>)
              .filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
          )
        : {};
    index[manuscriptId] = updatedAt;
    const retained = Object.entries(index).sort((a, b) => b[1] - a[1]);
    for (const [expiredId] of retained.slice(MAX_DRAFTS)) {
      delete index[expiredId];
      localStorage.removeItem(keyFor(expiredId));
    }
    localStorage.setItem(DRAFT_INDEX_KEY, JSON.stringify(index));
  } catch {
    // Index/capping failure must not turn a successful current draft write
    // into a false negative.
  }
  return true;
}

export function readManuscriptDraft(manuscriptId: string): ManuscriptDraftRecord | null {
  return readRecord(keyFor(manuscriptId), manuscriptId);
}

export function clearManuscriptDraft(manuscriptId: string): void {
  try {
    localStorage.removeItem(keyFor(manuscriptId));
    const rawIndex = localStorage.getItem(DRAFT_INDEX_KEY);
    if (!rawIndex) return;
    const index = JSON.parse(rawIndex) as Record<string, unknown>;
    if (!index || typeof index !== 'object' || Array.isArray(index)) return;
    delete index[manuscriptId];
    localStorage.setItem(DRAFT_INDEX_KEY, JSON.stringify(index));
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

/**
 * A conflict recovery copy is deliberately separate from the transient crash
 * journal. Continuing to edit the freshly loaded server version may update the
 * crash journal, but it must never overwrite the snapshot that lost a revision
 * race on another device.
 */
export function writeManuscriptConflictDraft(
  manuscriptId: string,
  manuscript: Manuscript,
): boolean {
  try {
    localStorage.setItem(conflictKeyFor(manuscriptId), JSON.stringify(makeRecord(manuscriptId, manuscript)));
    return true;
  } catch (error) {
    console.warn('Could not write the manuscript conflict recovery copy:', error);
    return false;
  }
}

export function readManuscriptConflictDraft(
  manuscriptId: string,
): ManuscriptDraftRecord | null {
  return readRecord(conflictKeyFor(manuscriptId), manuscriptId);
}

export function clearManuscriptConflictDraft(manuscriptId: string): void {
  try {
    localStorage.removeItem(conflictKeyFor(manuscriptId));
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}
