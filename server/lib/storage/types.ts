/**
 * Unified interface for blob-style storage.
 * Used for both primary (SQLite) and redundant (Nextcloud) layers.
 */
export interface StorageProvider {
  /** 
   * Writes a blob to storage.
   * @param key Unique identifier (e.g., 'covers/mybook.png' or 'manuscripts/123/metadata.json')
   * @param content The data to store.
   * @param contentType MIME type for HTTP-based providers (WebDAV/S3).
   */
  put(key: string, content: Buffer | string, contentType?: string): Promise<void>;

  /** 
   * Retrieves a blob from storage.
   */
  get(key: string): Promise<Buffer | null>;

  /** 
   * Deletes a blob from storage.
   */
  delete(key: string): Promise<void>;

  /** 
   * Lists keys under a prefix (directory-style).
   */
  list(prefix: string): Promise<string[]>;

  /**
   * Ensures a directory (collection) exists.
   */
  ensureDir(path: string): Promise<void>;
}
