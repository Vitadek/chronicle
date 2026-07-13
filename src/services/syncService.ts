import { authFetch, authService } from './authService';
import { PluginStateRecord } from '../types';

/**
 * Background pull against the server's monotonic /api/sync/v2 endpoint.
 *
 * Design intent:
 *   - The legacy CRUD API (manuscriptService) is the *write path* for the
 *     UI; every auto-save still hits /api/manuscripts directly so the user
 *     never sees latency.
 *   - This sync layer runs *in addition* on a timer (default 30s) to pull
 *     any changes made on other devices. It's optional — turning it off
 *     just degrades the app to single-device.
 *
 * Both paths share the same SQLite tables on the server, so writes from the
 * CRUD endpoint show up here on the next pull, and vice versa.
 */

const CURSOR_KEY = 'chronicle_sync_cursor_v2';
const EPOCH_KEY = 'chronicle_sync_epoch_v2';

function accountStorageKey(base: string): string {
  return `${base}:${authService.userId ?? 'unverified'}`;
}

function cursorKey(): string {
  // Change-log sequence numbers are global while pulls are user-filtered. A
  // cursor must therefore follow the verified account, or switching accounts
  // in one browser could skip the second account's older records.
  return accountStorageKey(CURSOR_KEY);
}

function epochKey(): string {
  return accountStorageKey(EPOCH_KEY);
}

function validEpoch(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

type SyncManuscript = {
  id: string;
  data: string;
  last_modified: number;
  deleted: boolean;
};
type SyncChapter = {
  id: string;
  manuscript_id: string;
  title: string | null;
  content: string | null;
  position: number | null;
  last_modified: number;
  deleted: boolean;
};
type SyncProfile = { data: string; last_modified: number } | null;

export interface SyncResponse {
  epoch: string;
  cursor: number;
  hasMore: boolean;
  reset: boolean;
  pull: {
    manuscripts: SyncManuscript[];
    chapters: SyncChapter[];
    profile: SyncProfile;
    plugins: PluginStateRecord[];
  };
}

/**
 * Pull-only sync: doesn't push, just asks the server for anything newer than
 * our last server sequence. Returns a compatibility-shaped pull so callers can decide
 * what to do (e.g. refresh the open manuscript, repaint the library).
 *
 * Push is handled implicitly by the existing PUT /api/manuscripts path. If
 * you want true offline-first push from this layer too, accumulate pending
 * changes in localStorage and send them as `push` in the body.
 */
export async function syncOnce(): Promise<SyncResponse | null> {
  const key = cursorKey();
  const historyKey = epochKey();
  const stored = Number.parseInt(localStorage.getItem(key) || '0', 10);
  const cursor = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  const storedEpoch = localStorage.getItem(historyKey);
  const epoch = validEpoch(storedEpoch) ? storedEpoch : undefined;
  // A cursor learned before epoch-aware sync cannot be assigned safely to the
  // current history. Adopt the first epoch through a bounded replay from zero.
  const requestCursor = epoch ? cursor : 0;
  let res: Response;
  try {
    res = await authFetch('/api/sync/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cursor: requestCursor,
        ...(epoch ? { epoch } : {}),
        changes: [],
      }),
    });
  } catch {
    // Network error — silently retry on next tick.
    return null;
  }
  if (!res.ok) {
    if (res.status === 401) {
      // Token went bad — surface for the UI to handle.
      window.dispatchEvent(new CustomEvent('chronicle:auth-required'));
    }
    return null;
  }
  const body = (await res.json()) as {
    epoch?: unknown;
    cursor?: unknown;
    hasMore?: unknown;
    reset?: unknown;
    changes?: Array<{
      entity?: unknown;
      id?: unknown;
      manuscriptId?: unknown;
      operation?: unknown;
      data?: unknown;
      title?: unknown;
      content?: unknown;
      position?: unknown;
      updatedAt?: unknown;
    }>;
  };
  if (
    !validEpoch(body.epoch) ||
    !Number.isSafeInteger(body.cursor) ||
    (body.cursor as number) < 0 ||
    !Array.isArray(body.changes)
  ) {
    return null;
  }

  const manuscripts: SyncManuscript[] = [];
  const chapters: SyncChapter[] = [];
  let profile: SyncProfile = null;
  for (const change of body.changes) {
    const updatedAt = typeof change.updatedAt === 'number' ? change.updatedAt : Date.now();
    const deleted = change.operation === 'delete';
    if (change.entity === 'manuscript' && typeof change.id === 'string') {
      manuscripts.push({
        id: change.id,
        data: typeof change.data === 'string' ? change.data : '{}',
        last_modified: updatedAt,
        deleted,
      });
    } else if (
      change.entity === 'chapter' &&
      typeof change.id === 'string' &&
      typeof change.manuscriptId === 'string'
    ) {
      chapters.push({
        id: change.id,
        manuscript_id: change.manuscriptId,
        title: typeof change.title === 'string' ? change.title : null,
        content: typeof change.content === 'string' ? change.content : null,
        position: typeof change.position === 'number' ? change.position : null,
        last_modified: updatedAt,
        deleted,
      });
    } else if (change.entity === 'profile' && typeof change.data === 'string') {
      profile = { data: change.data, last_modified: updatedAt };
    }
  }

  // Cursors are scoped to a durable history epoch. Treat an epoch change as a
  // reset defensively even if an older intermediary omitted the reset flag,
  // accept the replay cursor, and persist the new pair for this verified user.
  const reset = body.reset === true || epoch === undefined || body.epoch !== epoch;
  const nextCursor = reset ? (body.cursor as number) : Math.max(cursor, body.cursor as number);
  localStorage.setItem(key, String(nextCursor));
  localStorage.setItem(historyKey, body.epoch);
  return {
    epoch: body.epoch,
    cursor: nextCursor,
    hasMore: body.hasMore === true,
    reset,
    pull: { manuscripts, chapters, profile, plugins: [] },
  };
}

export interface SyncControllerOptions {
  intervalMs?: number;
  onPull?: (resp: SyncResponse) => void;
}

/**
 * Start a background sync loop. Returns a stop function.
 *
 * Triggers a sync:
 *   - immediately on start
 *   - every `intervalMs` (default 30s)
 *   - when the tab becomes visible (so opening laptop after lunch refreshes)
 *   - when the network reconnects
 */
export function startSync({
  intervalMs = 30_000,
  onPull,
}: SyncControllerOptions = {}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let rerunRequested = false;

  const tick = async () => {
    if (stopped) return;
    if (inFlight) {
      rerunRequested = true;
      return;
    }
    inFlight = true;
    try {
      do {
        rerunRequested = false;
        const resp = await syncOnce();
        if (resp && onPull) {
          try {
            onPull(resp);
          } catch (e) {
            console.warn('sync onPull handler threw:', e);
          }
        }
        if (resp?.hasMore) rerunRequested = true;
      } while (!stopped && rerunRequested);
    } finally {
      inFlight = false;
      if (!stopped) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, intervalMs);
      }
    }
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') tick();
  };
  const onOnline = () => tick();

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  };
}

/** Reset sync history state — useful after logout or when switching accounts. */
export function resetSyncCursor(): void {
  localStorage.removeItem(cursorKey());
  localStorage.removeItem(epochKey());
}
