import { StorageProvider } from './types';
import { db } from '../../db';
import { initializeStorageSchema, nextStorageGeneration, sha256 } from './schema';

export interface LocalBlobRecord {
  key: string;
  content: Buffer;
  contentType?: string;
  checksum: string;
  generation: number;
  updatedAt: number;
}

/** Authoritative binary object store. Remote replicas never participate in reads. */
export class SQLiteProvider implements StorageProvider {
  constructor() {
    initializeStorageSchema();
  }

  toBuffer(content: Buffer | string): Buffer {
    return Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8');
  }

  putAtGeneration(
    key: string,
    content: Buffer,
    contentType: string | undefined,
    generation: number,
    checksum = sha256(content),
  ): LocalBlobRecord {
    const updatedAt = Date.now();
    db.prepare(`
      INSERT INTO storage_blobs(
        key, content, content_type, checksum, generation, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        content = excluded.content,
        content_type = excluded.content_type,
        checksum = excluded.checksum,
        generation = excluded.generation,
        updated_at = excluded.updated_at
    `).run(key, content, contentType || null, checksum, generation, updatedAt);
    return { key, content, contentType, checksum, generation, updatedAt };
  }

  deleteAtGeneration(key: string, _generation: number): void {
    db.prepare('DELETE FROM storage_blobs WHERE key = ?').run(key);
  }

  async put(key: string, content: Buffer | string, contentType?: string): Promise<void> {
    const bytes = this.toBuffer(content);
    db.transaction(() => {
      const generation = nextStorageGeneration(key);
      this.putAtGeneration(key, bytes, contentType, generation);
    })();
  }

  async get(key: string): Promise<Buffer | null> {
    const row = db.prepare('SELECT content FROM storage_blobs WHERE key = ?').get(key) as
      | { content: Buffer }
      | undefined;
    return row ? Buffer.from(row.content) : null;
  }

  getRecord(key: string): LocalBlobRecord | null {
    const row = db.prepare(`
      SELECT key, content, content_type, checksum, generation, updated_at
      FROM storage_blobs WHERE key = ?
    `).get(key) as {
      key: string;
      content: Buffer;
      content_type: string | null;
      checksum: string;
      generation: number;
      updated_at: number;
    } | undefined;
    if (!row) return null;
    return {
      key: row.key,
      content: Buffer.from(row.content),
      contentType: row.content_type || undefined,
      checksum: row.checksum,
      generation: row.generation,
      updatedAt: row.updated_at,
    };
  }

  listRecords(prefix: string): LocalBlobRecord[] {
    const rows = db.prepare(`
      SELECT key, content, content_type, checksum, generation, updated_at
      FROM storage_blobs
      WHERE substr(key, 1, length(?)) = ?
      ORDER BY key
    `).all(prefix, prefix) as Array<{
      key: string;
      content: Buffer;
      content_type: string | null;
      checksum: string;
      generation: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      key: row.key,
      content: Buffer.from(row.content),
      contentType: row.content_type || undefined,
      checksum: row.checksum,
      generation: row.generation,
      updatedAt: row.updated_at,
    }));
  }

  async delete(key: string): Promise<void> {
    db.transaction(() => {
      const generation = nextStorageGeneration(key);
      this.deleteAtGeneration(key, generation);
    })();
  }

  async list(prefix: string): Promise<string[]> {
    return this.listRecords(prefix).map((row) => row.key);
  }

  async ensureDir(_path: string): Promise<void> {
    // SQLite has no directory abstraction.
  }
}
