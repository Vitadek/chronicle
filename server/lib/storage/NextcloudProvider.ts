import { StorageProvider } from './types';
import { config } from '../../config';

export class NextcloudProvider implements StorageProvider {
  private get baseUrl() {
    return `${config.nextcloud.url}/remote.php/dav/files/${encodeURIComponent(config.nextcloud.user)}`;
  }

  private get authHeader() {
    const creds = Buffer.from(`${config.nextcloud.user}:${config.nextcloud.pass}`).toString('base64');
    return { Authorization: `Basic ${creds}` };
  }

  async put(key: string, content: Buffer | string, contentType?: string): Promise<void> {
    const url = `${this.baseUrl}/${key}`;
    
    // Auto-create parent directories if needed
    const parts = key.split('/');
    if (parts.length > 1) {
      let current = '';
      for (let i = 0; i < parts.length - 1; i++) {
        current += (current ? '/' : '') + parts[i];
        await this.ensureDir(current);
      }
    }

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        ...this.authHeader,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body: content,
    });

    if (!res.ok && res.status !== 204 && res.status !== 201) {
      throw new Error(`Nextcloud PUT ${key} failed: ${res.status} ${res.statusText}`);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const url = `${this.baseUrl}/${key}`;
    const res = await fetch(url, {
      headers: this.authHeader,
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Nextcloud GET ${key} failed: ${res.status} ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async delete(key: string): Promise<void> {
    const url = `${this.baseUrl}/${key}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.authHeader,
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Nextcloud DELETE ${key} failed: ${res.status} ${res.statusText}`);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const url = `${this.baseUrl}/${prefix}`;
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        ...this.authHeader,
        Depth: '1',
      },
    });

    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error(`Nextcloud PROPFIND ${prefix} failed: ${res.status}`);
    }

    const text = await res.text();
    // Simplified regex-based XML parsing to avoid large XML dependencies.
    // Nextcloud XML usually contains <d:href> tags.
    const hrefs: string[] = [];
    const matches = text.matchAll(/<d:href>([^<]+)<\/d:href>/g);
    
    const rootPath = `/remote.php/dav/files/${encodeURIComponent(config.nextcloud.user)}/${prefix}`;
    
    for (const match of matches) {
      const decoded = decodeURIComponent(match[1]);
      if (decoded.endsWith('/') || decoded === rootPath) continue;
      
      // Extract the key relative to the storage root
      const parts = decoded.split(`${encodeURIComponent(config.nextcloud.user)}/`);
      if (parts.length > 1) {
        hrefs.push(parts[1]);
      }
    }

    return hrefs;
  }

  async ensureDir(path: string): Promise<void> {
    const url = `${this.baseUrl}/${path}`;
    const res = await fetch(url, {
      method: 'MKCOL',
      headers: this.authHeader,
    });

    // 405 Method Not Allowed usually means directory already exists
    if (!res.ok && res.status !== 405) {
      // Check if it's because a parent is missing (409)
      if (res.status === 409 && path.includes('/')) {
        const parent = path.substring(0, path.lastIndexOf('/'));
        await this.ensureDir(parent);
        return this.ensureDir(path);
      }
      // Silently ignore other errors for now (best-effort)
    }
  }
}
