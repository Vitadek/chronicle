import { useCallback, useEffect, useRef, useState } from 'react';
import type { Manuscript } from '../types';
import {
  ManuscriptServiceError,
  manuscriptService,
} from '../services/manuscriptService';
import {
  clearManuscriptConflictDraft,
  clearManuscriptDraft,
  readManuscriptConflictDraft,
  writeManuscriptConflictDraft,
  writeManuscriptDraft,
} from '../lib/manuscriptDraftJournal';

export type ManuscriptSaveStatus =
  | 'saved'
  | 'dirty'
  | 'saving'
  | 'offline'
  | 'error'
  | 'conflict'
  | 'draft-error';

interface SaveJob {
  sessionKey: number;
  manuscriptId: string;
  manuscript: Manuscript;
  version: number;
}

interface Observation {
  sessionKey: number;
  manuscript: Manuscript;
  version: number;
}

interface SaveConflict {
  sessionKey: number;
  manuscriptId: string;
  authoritative: Manuscript | null;
}

interface UseManuscriptAutosaveOptions {
  sessionKey: number | null;
  manuscriptId: string | null;
  manuscript: Manuscript | null;
  /** Fingerprint of the server response used to hydrate this session. */
  baselineFingerprint: string | null;
  debounceMs?: number;
  journalDebounceMs?: number;
  onSaved?: (saved: Manuscript, sessionKey: number) => void;
  onConflictReloaded?: (authoritative: Manuscript, sessionKey: number) => void;
  onConflictDraftRestored?: (draft: Manuscript, sessionKey: number) => void;
}

/**
 * Full fingerprints are reserved for one-time hydration/recovery comparison.
 * The keystroke path below uses immutable object identity plus a local version
 * and never serializes the whole book during render.
 */
export function manuscriptFingerprint(manuscript: Manuscript): string {
  const { revision: _metadataRevision, ...metadata } = manuscript.metadata;
  return JSON.stringify({
    metadata,
    chapters: manuscript.chapters.map(({ revision: _chapterRevision, ...chapter }) => chapter),
  });
}

function metadataEqualIgnoringRevision(a: Manuscript['metadata'], b: Manuscript['metadata']): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('revision');
  for (const key of keys) {
    if (!Object.is(
      (a as unknown as Record<string, unknown>)[key],
      (b as unknown as Record<string, unknown>)[key],
    )) return false;
  }
  return true;
}

function sameAuthorState(a: Manuscript, b: Manuscript): boolean {
  if (!metadataEqualIgnoringRevision(a.metadata, b.metadata)) return false;
  if (a.chapters.length !== b.chapters.length) return false;
  for (let index = 0; index < a.chapters.length; index += 1) {
    const left = a.chapters[index];
    const right = b.chapters[index];
    if (left === right) continue;
    if (
      left.id !== right.id ||
      left.title !== right.title ||
      left.content !== right.content ||
      left.lastModified !== right.lastModified
    ) return false;
  }
  return true;
}

/** Rebase a queued immutable snapshot onto revisions acknowledged by PUT A. */
function rebaseRevisions(manuscript: Manuscript, saved: Manuscript): Manuscript {
  const revisions = new Map(saved.chapters.map((chapter) => [chapter.id, chapter.revision]));
  return {
    ...manuscript,
    metadata: {
      ...manuscript.metadata,
      revision: saved.metadata.revision,
    },
    chapters: manuscript.chapters.map((chapter) => {
      const revision = revisions.get(chapter.id);
      return revision === chapter.revision ? chapter : { ...chapter, revision };
    }),
  };
}

function classifyFailure(error: unknown): ManuscriptSaveStatus {
  if (error instanceof ManuscriptServiceError && error.status === 409) return 'conflict';
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'offline';
  return 'error';
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

export function useManuscriptAutosave({
  sessionKey,
  manuscriptId,
  manuscript,
  baselineFingerprint,
  debounceMs = 2_000,
  journalDebounceMs = 300,
  onSaved,
  onConflictReloaded,
  onConflictDraftRestored,
}: UseManuscriptAutosaveOptions) {
  const [status, setStatus] = useState<ManuscriptSaveStatus>('saved');
  const [error, setError] = useState<string | null>(null);
  const [hasConflictRecovery, setHasConflictRecovery] = useState(false);

  const activeSessionRef = useRef<number | null>(null);
  const persistedVersionRef = useRef(0);
  const journalVersionRef = useRef<number | null>(null);
  const observationRef = useRef<Observation | null>(null);
  const pendingRef = useRef<SaveJob | null>(null);
  const latestRef = useRef<SaveJob | null>(null);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const journalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);
  const conflictRef = useRef<SaveConflict | null>(null);
  const restoringConflictDraftRef = useRef(false);
  const onSavedRef = useRef(onSaved);
  const onConflictReloadedRef = useRef(onConflictReloaded);
  const onConflictDraftRestoredRef = useRef(onConflictDraftRestored);
  onSavedRef.current = onSaved;
  onConflictReloadedRef.current = onConflictReloaded;
  onConflictDraftRestoredRef.current = onConflictDraftRestored;

  let currentVersion: number | null = null;
  if (sessionKey !== null && manuscriptId && manuscript) {
    const observed = observationRef.current;
    if (!observed || observed.sessionKey !== sessionKey) {
      observationRef.current = { sessionKey, manuscript, version: 0 };
    } else if (observed.manuscript !== manuscript) {
      if (!sameAuthorState(observed.manuscript, manuscript)) observed.version += 1;
      observed.manuscript = manuscript;
    }
    currentVersion = observationRef.current.version;
    latestRef.current = { sessionKey, manuscriptId, manuscript, version: currentVersion };
  } else {
    observationRef.current = null;
    latestRef.current = null;
  }

  const persistDraftRef = useRef<(job?: SaveJob | null) => boolean>(() => true);
  persistDraftRef.current = (job = latestRef.current) => {
    if (!job) return true;
    const stored = writeManuscriptDraft(job.manuscriptId, job.manuscript);
    if (activeSessionRef.current !== job.sessionKey) return stored;
    if (stored) {
      journalVersionRef.current = job.version;
      if (!isOnline() && !inFlightRef.current) {
        setStatus('offline');
        setError(null);
      }
    } else {
      setStatus('draft-error');
      setError(
        'Browser draft storage is unavailable. Keep this tab open or reconnect before leaving.',
      );
    }
    return stored;
  };

  const scheduleDraft = useCallback((delay: number) => {
    if (journalTimerRef.current) clearTimeout(journalTimerRef.current);
    journalTimerRef.current = setTimeout(() => {
      journalTimerRef.current = null;
      persistDraftRef.current();
    }, delay);
  }, []);

  const runPendingRef = useRef<() => Promise<boolean>>(async () => true);
  runPendingRef.current = async () => {
    if (pausedRef.current) return false;
    // A 409 is a latched state. Retrying the same revision cannot succeed and
    // may repeatedly apply unrelated non-conflicting records on the server.
    if (conflictRef.current) return false;
    if (inFlightRef.current) {
      const previousSucceeded = await inFlightRef.current;
      if (!previousSucceeded) return false;
      if (pendingRef.current) return runPendingRef.current();
      return true;
    }

    const job = pendingRef.current;
    if (!job) return true;
    if (!isOnline()) {
      const journaled = persistDraftRef.current(job);
      if (activeSessionRef.current === job.sessionKey && journaled) setStatus('offline');
      return false;
    }

    pendingRef.current = null;
    // One coalesced full serialization at save time, never per keystroke.
    persistDraftRef.current(job);
    if (activeSessionRef.current === job.sessionKey) {
      setStatus('saving');
      setError(null);
    }

    const request = (async (): Promise<boolean> => {
      try {
        const saved = await manuscriptService.update(job.manuscriptId, job.manuscript);
        if (activeSessionRef.current === job.sessionKey) {
          persistedVersionRef.current = job.version;
          onSavedRef.current?.(saved, job.sessionKey);

          const latest = latestRef.current;
          if (latest?.sessionKey === job.sessionKey) {
            const rebased = { ...latest, manuscript: rebaseRevisions(latest.manuscript, saved) };
            latestRef.current = rebased;
            if (rebased.version !== job.version) pendingRef.current = rebased;
          }
          if (pendingRef.current?.sessionKey === job.sessionKey) {
            pendingRef.current = {
              ...pendingRef.current,
              manuscript: rebaseRevisions(pendingRef.current.manuscript, saved),
            };
          }

          if (pendingRef.current) {
            setStatus('dirty');
          } else {
            clearManuscriptDraft(job.manuscriptId);
            journalVersionRef.current = job.version;
            setStatus('saved');
          }
          if (restoringConflictDraftRef.current) {
            clearManuscriptConflictDraft(job.manuscriptId);
            restoringConflictDraftRef.current = false;
            setHasConflictRecovery(false);
          }
        }
        return true;
      } catch (cause) {
        if (activeSessionRef.current === job.sessionKey) {
          const latest = latestRef.current;
          pendingRef.current = latest?.sessionKey === job.sessionKey ? latest : job;
          const nextStatus = classifyFailure(cause);
          const draftWriteSucceeded = persistDraftRef.current(pendingRef.current);
          const hasRecovery = draftWriteSucceeded ||
            journalVersionRef.current === pendingRef.current.version;
          if (nextStatus === 'conflict') {
            conflictRef.current = {
              sessionKey: job.sessionKey,
              manuscriptId: job.manuscriptId,
              authoritative: cause instanceof ManuscriptServiceError
                ? cause.authoritativeManuscript
                : null,
            };
          }
          setStatus(
            nextStatus === 'conflict'
              ? 'conflict'
              : !hasRecovery ? 'draft-error' : nextStatus,
          );
          if (nextStatus === 'conflict') {
            setError(
              cause instanceof ManuscriptServiceError && cause.authoritativeManuscript
                ? hasRecovery
                  ? `${cause.message}. Reload the server version to resolve it; Chronicle will preserve your local edits as a separate recovery copy first.`
                  : `${cause.message}. Browser draft storage is unavailable; keep this tab open. Reload remains blocked unless Chronicle can first preserve your local edits.`
                : `${cause instanceof Error ? cause.message : 'Save conflict'}. Keep this tab open and reopen the manuscript to load the server version.`,
            );
          } else {
            setError(
              !hasRecovery
                ? `${nextStatus === 'offline' ? 'Offline' : 'The remote save failed'}, and browser draft storage is unavailable. Keep this tab open to avoid losing the latest changes.`
                : cause instanceof Error ? cause.message : 'Failed to save manuscript',
            );
          }
        }
        return false;
      } finally {
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = request;
    const succeeded = await request;
    if (succeeded && pendingRef.current) return runPendingRef.current();
    return succeeded && !pendingRef.current;
  };

  const schedule = useCallback((delay: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (pausedRef.current) {
      timerRef.current = null;
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runPendingRef.current();
    }, delay);
  }, []);

  useEffect(() => {
    if (
      sessionKey === null ||
      !manuscriptId ||
      !manuscript ||
      currentVersion === null
    ) {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (journalTimerRef.current) clearTimeout(journalTimerRef.current);
      timerRef.current = null;
      journalTimerRef.current = null;
      activeSessionRef.current = null;
      pausedRef.current = false;
      pendingRef.current = null;
      journalVersionRef.current = null;
      conflictRef.current = null;
      restoringConflictDraftRef.current = false;
      setHasConflictRecovery(false);
      persistedVersionRef.current = 0;
      setStatus('saved');
      setError(null);
      return;
    }

    if (activeSessionRef.current !== sessionKey) {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (journalTimerRef.current) clearTimeout(journalTimerRef.current);
      timerRef.current = null;
      journalTimerRef.current = null;
      activeSessionRef.current = sessionKey;
      pausedRef.current = false;
      const initialDirty = baselineFingerprint !== null &&
        manuscriptFingerprint(manuscript) !== baselineFingerprint;
      persistedVersionRef.current = initialDirty ? currentVersion - 1 : currentVersion;
      journalVersionRef.current = initialDirty ? null : currentVersion;
      pendingRef.current = null;
      conflictRef.current = null;
      restoringConflictDraftRef.current = false;
      setHasConflictRecovery(readManuscriptConflictDraft(manuscriptId) !== null);
      setError(null);
    }

    if (currentVersion === persistedVersionRef.current) {
      if (!inFlightRef.current) setStatus('saved');
      return;
    }

    const latest = latestRef.current;
    if (!latest || latest.sessionKey !== sessionKey) return;
    pendingRef.current = latest;
    // Stay truthful until the debounced local journal confirms an offline
    // recovery copy; only then may the UI say the draft is kept locally.
    if (!inFlightRef.current) setStatus('dirty');
    scheduleDraft(journalDebounceMs);
    if (conflictRef.current?.sessionKey === sessionKey) {
      setStatus('conflict');
      return;
    }
    schedule(debounceMs);
  }, [
    baselineFingerprint,
    currentVersion,
    debounceMs,
    journalDebounceMs,
    manuscript,
    manuscriptId,
    schedule,
    scheduleDraft,
    sessionKey,
  ]);

  const retry = useCallback(() => {
    if (conflictRef.current) return;
    const latest = latestRef.current;
    if (latest && latest.version !== persistedVersionRef.current) {
      pendingRef.current = latest;
      setStatus('dirty');
      setError(null);
      scheduleDraft(0);
      schedule(0);
    }
  }, [schedule, scheduleDraft]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (journalTimerRef.current) clearTimeout(journalTimerRef.current);
    timerRef.current = null;
    journalTimerRef.current = null;
    const latest = latestRef.current;
    if (latest && latest.version !== persistedVersionRef.current) {
      pendingRef.current = latest;
      persistDraftRef.current(latest);
    }
    if (conflictRef.current) return false;
    if (inFlightRef.current) {
      const succeeded = await inFlightRef.current;
      if (!succeeded) return false;
    }
    if (pendingRef.current) return runPendingRef.current();
    return true;
  }, []);

  /**
   * Wait for an old PUT and suspend the queue before a destructive operation.
   * The persisted version is intentionally unchanged so resume() can restore
   * the exact in-memory snapshot if that destructive request fails.
   */
  const discard = useCallback(async (): Promise<void> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (journalTimerRef.current) clearTimeout(journalTimerRef.current);
    timerRef.current = null;
    journalTimerRef.current = null;
    pendingRef.current = null;
    if (inFlightRef.current) await inFlightRef.current;
    pendingRef.current = null;
    const latest = latestRef.current;
    // The destructive request has not succeeded yet. Keep its crash journal
    // until the caller confirms deletion.
    const recoveryStored = latest ? persistDraftRef.current(latest) : true;
    if (
      latest &&
      latest.version !== persistedVersionRef.current &&
      !conflictRef.current &&
      (recoveryStored || journalVersionRef.current === latest.version)
    ) {
      setStatus('dirty');
    }
  }, []);

  /** Hold newly scheduled PUTs around an explicit chapter DELETE. */
  const pause = useCallback(() => {
    pausedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    const latest = latestRef.current;
    if (!pendingRef.current && latest && latest.version !== persistedVersionRef.current) {
      pendingRef.current = latest;
    }
    if (conflictRef.current) {
      setStatus('conflict');
      return;
    }
    if (pendingRef.current) schedule(debounceMs);
  }, [debounceMs, schedule]);

  /** True only when the latest in-memory author state has a confirmed crash-journal copy. */
  const hasRecoveryDraft = useCallback((): boolean => {
    const latest = latestRef.current;
    return !!latest &&
      latest.sessionKey === activeSessionRef.current &&
      journalVersionRef.current === latest.version;
  }, []);

  const reloadServerVersion = useCallback((): boolean => {
    const conflict = conflictRef.current;
    const local = latestRef.current;
    if (
      !conflict ||
      !conflict.authoritative ||
      !local ||
      local.sessionKey !== conflict.sessionKey ||
      activeSessionRef.current !== conflict.sessionKey
    ) return false;

    // This write is the commit point: never replace the editor state unless
    // the losing local snapshot has its own durable, non-overwritten copy.
    if (readManuscriptConflictDraft(conflict.manuscriptId)) {
      setHasConflictRecovery(true);
      setStatus('conflict');
      setError(
        'An earlier local conflict copy is still preserved. Restore or discard that copy before reloading this newer server version.',
      );
      return false;
    }
    if (!writeManuscriptConflictDraft(conflict.manuscriptId, local.manuscript)) {
      setStatus('conflict');
      setError(
        'The server version was not loaded because Chronicle could not preserve your local edits. Keep this tab open and free browser storage before retrying.',
      );
      return false;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    if (journalTimerRef.current) clearTimeout(journalTimerRef.current);
    timerRef.current = null;
    journalTimerRef.current = null;
    clearManuscriptDraft(conflict.manuscriptId);
    journalVersionRef.current = null;
    pendingRef.current = null;

    const version = observationRef.current?.sessionKey === conflict.sessionKey
      ? observationRef.current.version
      : local.version;
    observationRef.current = {
      sessionKey: conflict.sessionKey,
      manuscript: conflict.authoritative,
      version,
    };
    persistedVersionRef.current = version;
    latestRef.current = {
      sessionKey: conflict.sessionKey,
      manuscriptId: conflict.manuscriptId,
      manuscript: conflict.authoritative,
      version,
    };
    conflictRef.current = null;
    setHasConflictRecovery(true);
    setStatus('saved');
    setError(null);
    onConflictReloadedRef.current?.(conflict.authoritative, conflict.sessionKey);
    return true;
  }, []);

  const restoreConflictDraft = useCallback((): boolean => {
    const latest = latestRef.current;
    if (!latest || latest.sessionKey !== activeSessionRef.current) return false;
    const recovery = readManuscriptConflictDraft(latest.manuscriptId);
    if (!recovery) {
      setHasConflictRecovery(false);
      return false;
    }

    const restored = rebaseRevisions(recovery.manuscript, latest.manuscript);
    const version = Math.max(
      persistedVersionRef.current,
      observationRef.current?.version ?? 0,
    ) + 1;
    observationRef.current = { sessionKey: latest.sessionKey, manuscript: restored, version };
    const restoredJob = { ...latest, manuscript: restored, version };
    latestRef.current = restoredJob;
    pendingRef.current = restoredJob;
    restoringConflictDraftRef.current = true;
    if (persistDraftRef.current(restoredJob)) journalVersionRef.current = version;
    setStatus('dirty');
    setError(null);
    onConflictDraftRestoredRef.current?.(restored, latest.sessionKey);
    schedule(0);
    return true;
  }, [schedule]);

  const discardConflictDraft = useCallback(() => {
    const manuscriptId = latestRef.current?.manuscriptId;
    if (manuscriptId) clearManuscriptConflictDraft(manuscriptId);
    restoringConflictDraftRef.current = false;
    setHasConflictRecovery(false);
  }, []);

  const versionDirty = currentVersion !== null && currentVersion !== persistedVersionRef.current;
  const isDirty = versionDirty || status !== 'saved';

  useEffect(() => {
    const handleOnline = () => {
      if (pendingRef.current) retry();
    };
    const handleOffline = () => {
      if (!pendingRef.current) return;
      const journaled = persistDraftRef.current(pendingRef.current);
      if (journaled) setStatus('offline');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [retry]);

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      persistDraftRef.current();
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (journalTimerRef.current) clearTimeout(journalTimerRef.current);
  }, []);

  return {
    status,
    error,
    isDirty,
    hasConflictRecovery,
    canReloadServerVersion: conflictRef.current?.authoritative !== null &&
      conflictRef.current?.authoritative !== undefined,
    retry,
    flush,
    discard,
    pause,
    resume,
    hasRecoveryDraft,
    reloadServerVersion,
    restoreConflictDraft,
    discardConflictDraft,
  };
}
