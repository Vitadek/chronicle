import { StorageProvider } from './types';
import { SQLiteProvider } from './SQLiteProvider';
import { NextcloudProvider } from './NextcloudProvider';
import { config } from '../../config';
import { db } from '../../db';

/**
 * Orchestrates dual-write storage between local SQLite and remote Nextcloud.
 */
export class HybridStorageManager implements StorageProvider {
  private local = new SQLiteProvider();
  private remote = new NextcloudProvider();

  constructor() {
    this.initOutbox();
    this.startBackgroundSync();
  }

  private initOutbox() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS storage_outbox (
        key             TEXT PRIMARY KEY,
        action          TEXT NOT NULL, -- 'put' or 'delete'
        content_type    TEXT,
        attempts        INTEGER DEFAULT 0,
        last_attempt_at INTEGER
      )
    `);
  }

  async put(key: string, content: Buffer | string, contentType?: string): Promise<void> {
    // 1. Primary write (Local SQLite) - Instant
    await this.local.put(key, content, contentType);

    if (config.storageProvider === 'hybrid') {
      // 2. Queue for Redundancy (Nextcloud)
      db.prepare(`
        INSERT INTO storage_outbox (key, action, content_type, attempts)
        VALUES (?, 'put', ?, 0)
        ON CONFLICT(key) DO UPDATE SET
          action = 'put',
          content_type = excluded.content_type,
          attempts = 0
      `).run(key, contentType || null);
      
      // 3. Fire-and-forget immediate push attempt
      this.syncKey(key).catch(() => {});
    }
  }

  async get(key: string): Promise<Buffer | null> {
    // Try local first
    let content = await this.local.get(key);
    
    // If missing locally but hybrid is on, try re-hydrating from remote
    if (!content && config.storageProvider === 'hybrid') {
      try {
        content = await this.remote.get(key);
        if (content) {
          // Cache it locally for next time
          await this.local.put(key, content);
        }
      } catch (err) {
        console.warn(`Failed to re-hydrate ${key} from Nextcloud:`, err);
      }
    }
    
    return content;
  }

  async delete(key: string): Promise<void> {
    await this.local.delete(key);

    if (config.storageProvider === 'hybrid') {
      db.prepare(`
        INSERT INTO storage_outbox (key, action, attempts)
        VALUES (?, 'delete', 0)
        ON CONFLICT(key) DO UPDATE SET
          action = 'delete',
          attempts = 0
      `).run(key);
      
      this.syncKey(key).catch(() => {});
    }
  }

  async list(prefix: string): Promise<string[]> {
    // Local list is the source of truth for the index
    return this.local.list(prefix);
  }

  async ensureDir(path: string): Promise<void> {
    await this.local.ensureDir(path);
    if (config.storageProvider === 'hybrid') {
      await this.remote.ensureDir(path);
    }
  }

  /**
   * Attempts to sync a single key to Nextcloud.
   */
  private async syncKey(key: string): Promise<void> {
    const row = db.prepare('SELECT action, content_type FROM storage_outbox WHERE key = ?').get(key) as { action: string, content_type: string | null } | undefined;
    if (!row) return;

    try {
      if (row.action === 'put') {
        const content = await this.local.get(key);
        if (content) {
          await this.remote.put(key, content, row.content_type || undefined);
        }
      } else if (row.action === 'delete') {
        await this.remote.delete(key);
      }
      
      // Success: Remove from outbox
      db.prepare('DELETE FROM storage_outbox WHERE key = ?').run(key);
    } catch (err) {
      // Failure: Increment attempts
      db.prepare('UPDATE storage_outbox SET attempts = attempts + 1, last_attempt_at = ? WHERE key = ?')
        .run(Date.now(), key);
      throw err;
    }
  }

  /**
   * Periodically retries failed syncs.
   */
  private startBackgroundSync() {
    setInterval(async () => {
      if (config.storageProvider !== 'hybrid') return;

      const pending = db.prepare('SELECT key FROM storage_outbox WHERE attempts < 10 LIMIT 50').all() as { key: string }[];
      
      for (const item of pending) {
        try {
          await this.syncKey(item.key);
        } catch {
          // background sync errors are silent, we retry next interval
        }
      }
    }, 1000 * 60 * 5); // Every 5 minutes
  }
}

// Export a singleton instance
export const storage = new HybridStorageManager();
