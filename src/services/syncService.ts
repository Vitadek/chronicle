import { authFetch } from './authService';
import { PluginStateRecord } from '../types';

/**
 * Background sync against the server's /api/sync endpoint.
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

const SINCE_KEY = 'chronicle_sync_since';

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
  serverTime: number;
  pull: {
    manuscripts: SyncManuscript[];
    chapters: SyncChapter[];
    profile: SyncProfile;
    plugins: PluginStateRecord[];
  };
}

/**
 * Pull-only sync: doesn't push, just asks the server for anything newer than
 * our last `since` cursor. Returns the raw response so callers can decide
 * what to do (e.g. refresh the open manuscript, repaint the library).
 *
 * Push is handled implicitly by the existing PUT /api/manuscripts path. If
 * you want true offline-first push from this layer too, accumulate pending
 * changes in localStorage and send them as `push` in the body.
 */
export async function syncOnce(): Promise<SyncResponse | null> {
  const since = parseInt(localStorage.getItem(SINCE_KEY) || '0', 10);
  let res: Response;
  try {
    res = await authFetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since, push: { manuscripts: [], chapters: [], plugins: [] } }),
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
  const body = (await res.json()) as SyncResponse;
  localStorage.setItem(SINCE_KEY, String(body.serverTime));
  return body;
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

  const tick = async () => {
    if (stopped) return;
    const resp = await syncOnce();
    if (resp && onPull) {
      try {
        onPull(resp);
      } catch (e) {
        console.warn('sync onPull handler threw:', e);
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
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

/** Reset the sync cursor — useful after logout or when switching accounts. */
export function resetSyncCursor(): void {
  localStorage.removeItem(SINCE_KEY);
}
