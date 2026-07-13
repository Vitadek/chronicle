import { authFetch } from './authService';

/** How a plugin got onto this instance. */
export type PluginSource = 'seed' | 'git' | 'local';

/** One incoming commit, shown in the update prompt. */
export interface PluginCommit {
  oid: string;
  message: string;
}

/** A plugin installed on disk, merged with this user's enable/state record. */
export interface InstalledPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  source: PluginSource;
  gitUrl?: string;
  /** Short commit currently checked out (git sources). */
  commit?: string;
  /** Pinned ref (tag/commit); when set, updates are not offered. */
  pinnedRef?: string | null;
  /** Set when the server's esbuild compile failed — shown in Settings. */
  buildError?: string | null;
  /** This user's toggle + persisted state. */
  enabled: boolean;
  state: string;
  /** Populated by POST /:id/check-updates. */
  updateAvailable?: boolean;
  incoming?: PluginCommit[];
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    let msg = `${what} failed`;
    try {
      const e = await res.json();
      msg = e?.error || msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const pluginService = {
  async list(): Promise<InstalledPlugin[]> {
    const res = await authFetch('/api/plugins');
    const data = await json<{ plugins: InstalledPlugin[] }>(res, 'Listing plugins');
    return data.plugins;
  },

  /** Install from a git URL, or from a local folder path (dev escape hatch). */
  async install(source: { url?: string; path?: string }): Promise<InstalledPlugin> {
    const res = await authFetch('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(source),
    });
    const data = await json<{ plugin: InstalledPlugin }>(res, 'Install');
    return data.plugin;
  },

  /** Fetch from the remote and report what would be pulled. */
  async checkUpdates(id: string): Promise<{ updateAvailable: boolean; incoming: PluginCommit[] }> {
    const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}/check-updates`, { method: 'POST' });
    return json(res, 'Checking for updates');
  },

  /** Pull + rebuild. */
  async update(id: string): Promise<InstalledPlugin> {
    const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}/update`, { method: 'POST' });
    const data = await json<{ plugin: InstalledPlugin }>(res, 'Update');
    return data.plugin;
  },

  /** Pin to a tag/commit (or pass null to unpin). */
  async pin(id: string, ref: string | null): Promise<InstalledPlugin> {
    const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    });
    const data = await json<{ plugin: InstalledPlugin }>(res, 'Pin');
    return data.plugin;
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}/enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error('Failed to toggle plugin');
  },

  /** Persist plugin state. `manuscriptId` null = global scope. */
  async setState(id: string, state: unknown, manuscriptId: string | null): Promise<void> {
    const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: JSON.stringify(state), manuscriptId }),
    });
    if (!res.ok) throw new Error('Failed to save plugin state');
  },

  async uninstall(id: string): Promise<void> {
    const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to uninstall plugin');
  },
};
