/** Local blob API used by covers and settings. SQLite is always authoritative. */
export interface StorageProvider {
  put(key: string, content: Buffer | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  ensureDir(path: string): Promise<void>;
}

export interface ReplicaPutOptions {
  contentType?: string;
  checksum: string;
  generation: number;
}

export interface ReplicaObjectMetadata {
  key: string;
  size?: number;
  contentType?: string;
  checksum?: string;
  generation?: number;
  etag?: string;
  updatedAt?: Date;
}

/** Remote, asynchronous copy of Chronicle-owned objects. Never a live read store. */
export interface ReplicaProvider {
  readonly name: 'nextcloud' | 's3';
  initialize(): Promise<void>;
  put(key: string, content: Buffer, options: ReplicaPutOptions): Promise<void>;
  head(key: string): Promise<ReplicaObjectMetadata | null>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<ReplicaObjectMetadata[]>;
  close?(): void;
}

export interface StorageMutation {
  key: string;
  checksum?: string;
  generation: number;
}

export type ReplicaHealth = 'disabled' | 'healthy' | 'degraded';

export interface ReplicationStatus {
  provider: 'none' | 'nextcloud' | 's3';
  state: ReplicaHealth;
  initialized: boolean;
  pending: number;
  deadLetters: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export interface ReplicaVerificationResult {
  checked: number;
  matched: number;
  missing: string[];
  /** Remote objects absent from desired state or retained despite desired delete. */
  unexpected: string[];
  mismatched: Array<{
    key: string;
    expectedChecksum: string;
    actualChecksum?: string;
    expectedGeneration: number;
    actualGeneration?: number;
  }>;
  /** Providers such as WebDAV may not expose Chronicle metadata on HEAD. */
  unverifiable: string[];
}
