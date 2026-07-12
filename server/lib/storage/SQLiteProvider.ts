import { StorageProvider } from './types';
import { db } from '../../db';

export class SQLiteProvider implements StorageProvider {
  // contentType accepted to satisfy StorageProvider; SQLite ignores it (the
  // serve path re-derives mime from the key's extension).
  async put(key: string, content: Buffer | string, _contentType?: string): Promise<void> {
    const value = typeof content === 'string' ? content : content.toString('base64');
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, value);
  }

  async get(key: string): Promise<Buffer | null> {
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
    if (!row) return null;
    
    // Check if it's base64 (crude check, but works for our blobs)
    try {
      if (row.v.length > 0 && !row.v.includes(' ')) {
        return Buffer.from(row.v, 'base64');
      }
    } catch {
      // ignore and return as raw buffer
    }
    return Buffer.from(row.v);
  }

  async delete(key: string): Promise<void> {
    db.prepare('DELETE FROM kv WHERE k = ?').run(key);
  }

  async list(prefix: string): Promise<string[]> {
    const rows = db.prepare('SELECT k FROM kv WHERE k LIKE ?').all(`${prefix}%`) as { k: string }[];
    return rows.map(r => r.k);
  }

  async ensureDir(_path: string): Promise<void> {
    // No-op for KV-based SQLite storage
  }
}
