import { randomUUID } from 'node:crypto';
import { db } from '../db';

const SYNC_HISTORY_EPOCH_KEY = 'sync:history-epoch:v2';

/**
 * Stable identity for the current change-log history.
 *
 * A cursor is meaningful only within one history. Keeping that identity in
 * SQLite lets clients distinguish a restored history even after its sequence
 * has advanced beyond a cursor issued before the restore.
 */
export function getSyncHistoryEpoch(): string {
  const current = db.prepare('SELECT v FROM kv WHERE k = ?').get(
    SYNC_HISTORY_EPOCH_KEY,
  ) as { v: string } | undefined;
  if (current) return current.v;

  const created = randomUUID();
  db.prepare(`
    INSERT OR IGNORE INTO kv(k, v, expires_at) VALUES (?, ?, NULL)
  `).run(SYNC_HISTORY_EPOCH_KEY, created);
  return (db.prepare('SELECT v FROM kv WHERE k = ?').get(
    SYNC_HISTORY_EPOCH_KEY,
  ) as { v: string }).v;
}

/** Rotate the history identity atomically with an explicit restore apply. */
export function rotateSyncHistoryEpoch(): string {
  const next = randomUUID();
  db.prepare(`
    INSERT INTO kv(k, v, expires_at) VALUES (?, ?, NULL)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = NULL
  `).run(SYNC_HISTORY_EPOCH_KEY, next);
  return next;
}
