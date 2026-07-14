import { authFetch } from './authService';
import type { PluginStatus } from '../plugins/api';

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

  // --- dependency system (declared in the manifest, resolved by the server) ---
  provides: string[];
  requires: string[];
  wants: string[];
  conflicts: string[];
  replaces: string[];
  dependencies: Record<string, string>;
  /** The server's verdict. The client renders this; it never re-derives it. */
  status: PluginStatus;
  /**
   * WHY each unmet requirement is unmet, and what to do — "LanguageTool is not
   * reachable at http://languagetool:8010. Start the sidecar (see
   * docker-compose.yml) or set LANGUAGETOOL_URL." Parallel to `status.missing` /
   * `status.unmetWants`. Composed server-side so there is one wording, not two.
   */
  missingReasons: string[];
  unmetWantsReasons: string[];
}

/** POST /api/plugins/install: the plugin, plus whether it can actually run. */
export interface InstallResult {
  plugin: InstalledPlugin;
  /** Hard requirements the host can't satisfy — it installed, but won't enable. */
  missing: string[];
  missingReasons: string[];
  /** Soft requirements — it will enable, but limited. */
  unmetWants: string[];
  unmetWantsReasons: string[];
}

/** Everything GET /api/plugins returns: the list, plus its resolution. */
export interface PluginState {
  plugins: InstalledPlugin[];
  /** Host services currently available (`host:languagetool`, `host:ai`, …). */
  hostCapabilities: string[];
  /** `core:*` features suppressed because an enabled plugin replaces them. */
  shadowedCore: string[];
  /** Enabled plugins in dependency order — activate in this sequence. */
  activationOrder: string[];
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
  /** The installed list AND the server's dependency resolution for it. */
  async list(): Promise<PluginState> {
    const res = await authFetch('/api/plugins');
    return json<PluginState>(res, 'Listing plugins');
  },

  /**
   * Install from a git URL, or from a local folder path (dev escape hatch).
   *
   * Returns the plugin AND whether the host can actually run it: a plugin can
   * install and build perfectly and still refuse to enable (the Proofreader
   * without the LanguageTool sidecar). Settings surfaces that immediately
   * rather than leaving the user to work it out from a dead toggle.
   */
  async install(source: { url?: string; path?: string }): Promise<InstallResult> {
    const res = await authFetch('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(source),
    });
    return json<InstallResult>(res, 'Install');
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

  /**
   * Toggle. The server rejects this with a 409 when the dependency rules say no
   * (unmet requirement, conflict, or another plugin depends on this one) — its
   * message names exactly what's wrong, so surface it rather than a generic one.
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}/enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    await json(res, enabled ? 'Enabling plugin' : 'Disabling plugin');
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

  /** Refused with a 409 (naming them) if other enabled plugins depend on this one. */
  async uninstall(id: string): Promise<void> {
    const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await json(res, 'Uninstall');
  },
};
