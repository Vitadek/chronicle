import { config } from '../../config';
import type {
  ReplicaObjectMetadata,
  ReplicaProvider,
  ReplicaPutOptions,
} from './types';

function safeSegments(path: string, allowEmpty = false): string[] {
  const segments = path.split('/').filter(Boolean);
  if ((!segments.length && !allowEmpty) || segments.some((part) => part === '.' || part === '..')) {
    throw new Error(`Invalid Nextcloud replica path: ${path}`);
  }
  return segments;
}

function encodeSegments(segments: string[]): string {
  return segments.map(encodeURIComponent).join('/');
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Nextcloud WebDAV implementation of the asynchronous replica contract. */
export class NextcloudProvider implements ReplicaProvider {
  readonly name = 'nextcloud' as const;
  private readonly rootSegments = safeSegments(config.nextcloud.storageDir);

  private get userBaseUrl(): string {
    return `${config.nextcloud.url}/remote.php/dav/files/${encodeURIComponent(config.nextcloud.user)}`;
  }

  private get rootUrl(): string {
    return `${this.userBaseUrl}/${encodeSegments(this.rootSegments)}`;
  }

  private get authHeader(): { Authorization: string } {
    const credentials = Buffer.from(
      `${config.nextcloud.user}:${config.nextcloud.pass}`,
    ).toString('base64');
    return { Authorization: `Basic ${credentials}` };
  }

  private urlFor(key: string): string {
    return `${this.rootUrl}/${encodeSegments(safeSegments(key))}`;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: { ...this.authHeader, ...(init.headers || {}) },
      signal: AbortSignal.timeout(20_000),
    });
  }

  async initialize(): Promise<void> {
    const endpoint = new URL(config.nextcloud.url);
    if (endpoint.protocol !== 'https:' && !config.nextcloud.allowInsecureHttp) {
      throw new Error(
        'Refusing insecure Nextcloud endpoint; set NEXTCLOUD_ALLOW_INSECURE_HTTP=true only for a trusted LAN.',
      );
    }
    let current = this.userBaseUrl;
    for (const segment of this.rootSegments) {
      current += `/${encodeURIComponent(segment)}`;
      const response = await this.request(current, { method: 'MKCOL' });
      // 405 means the collection already exists.
      if (!response.ok && response.status !== 405) {
        throw new Error(
          `Nextcloud could not create NC_DIR=${config.nextcloud.storageDir}: ` +
          `${response.status} ${response.statusText}`,
        );
      }
    }
  }

  async put(key: string, content: Buffer, options: ReplicaPutOptions): Promise<void> {
    const segments = safeSegments(key);
    if (segments.length > 1) {
      await this.ensureDir(segments.slice(0, -1).join('/'));
    }
    const response = await this.request(this.urlFor(key), {
      method: 'PUT',
      headers: {
        ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
        // Nextcloud stores/exposes OC-Checksum on supported versions. The
        // generation remains authoritative in Chronicle's local outbox.
        'OC-Checksum': `SHA256:${options.checksum}`,
        'X-Chronicle-Generation': String(options.generation),
      },
      body: content,
    });
    if (!response.ok) {
      throw new Error(
        `Nextcloud PUT ${key} failed: ${response.status} ${response.statusText}`,
      );
    }
  }

  async head(key: string): Promise<ReplicaObjectMetadata | null> {
    const response = await this.request(this.urlFor(key), { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Nextcloud HEAD ${key} failed: ${response.status} ${response.statusText}`,
      );
    }
    const checksumHeader = response.headers.get('oc-checksum') || undefined;
    const checksum = checksumHeader?.replace(/^SHA256:/i, '').toLowerCase();
    const rawGeneration = response.headers.get('x-chronicle-generation');
    const generation = rawGeneration === null ? undefined : Number(rawGeneration);
    const rawSize = response.headers.get('content-length');
    const updatedAt = response.headers.get('last-modified');
    return {
      key,
      size: rawSize === null ? undefined : Number(rawSize),
      contentType: response.headers.get('content-type') || undefined,
      checksum,
      generation: Number.isSafeInteger(generation) ? generation : undefined,
      etag: response.headers.get('etag') || undefined,
      updatedAt: updatedAt ? new Date(updatedAt) : undefined,
    };
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.request(this.urlFor(key), { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Nextcloud GET ${key} failed: ${response.status} ${response.statusText}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.request(this.urlFor(key), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Nextcloud DELETE ${key} failed: ${response.status} ${response.statusText}`,
      );
    }
  }

  private async readDirectory(relativePath: string): Promise<Array<{
    key: string;
    collection: boolean;
  }>> {
    const url = relativePath ? this.urlFor(relativePath) : this.rootUrl;
    const response = await this.request(url, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml' },
    });
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(
        `Nextcloud PROPFIND ${relativePath} failed: ${response.status} ${response.statusText}`,
      );
    }

    const rootPath = decodeURIComponent(new URL(this.rootUrl).pathname).replace(/\/+$/, '');
    const entries: Array<{ key: string; collection: boolean }> = [];
    const xml = await response.text();
    const blocks = xml.match(/<(?:[A-Za-z][\w.-]*:)?response\b[\s\S]*?<\/(?:[A-Za-z][\w.-]*:)?response>/gi) || [];
    for (const block of blocks) {
      const href = block.match(/<(?:[A-Za-z][\w.-]*:)?href\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?href>/i)?.[1];
      if (!href) continue;
      const path = decodeURIComponent(new URL(decodeXmlText(href.trim()), config.nextcloud.url).pathname)
        .replace(/\/+$/, '');
      if (path === rootPath || !path.startsWith(`${rootPath}/`)) continue;
      const key = path.slice(rootPath.length + 1);
      if (!key) continue;
      entries.push({
        key,
        collection: /<(?:[A-Za-z][\w.-]*:)?collection\b/i.test(block),
      });
    }
    return entries;
  }

  async list(prefix: string): Promise<ReplicaObjectMetadata[]> {
    const normalizedPrefix = safeSegments(prefix, true).join('/');
    const root = normalizedPrefix.replace(/\/+$/, '');
    const queue = [root];
    const visited = new Set<string>();
    const objects: ReplicaObjectMetadata[] = [];

    while (queue.length) {
      const directory = queue.shift()!;
      if (visited.has(directory)) continue;
      visited.add(directory);
      for (const entry of await this.readDirectory(directory)) {
        if (entry.collection) queue.push(entry.key);
        else if (!root || entry.key.startsWith(root)) objects.push({ key: entry.key });
      }
    }
    return objects;
  }

  async ensureDir(path: string): Promise<void> {
    const segments = safeSegments(path, true);
    let current = this.rootUrl;
    for (const segment of segments) {
      current += `/${encodeURIComponent(segment)}`;
      const response = await this.request(current, { method: 'MKCOL' });
      if (!response.ok && response.status !== 405) {
        throw new Error(
          `Nextcloud MKCOL ${path} failed: ${response.status} ${response.statusText}`,
        );
      }
    }
  }
}
