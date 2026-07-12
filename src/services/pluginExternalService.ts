import { authFetch } from './authService';

export interface ExternalPluginManifest {
  id: string;
  name: string;
  description: string;
  entry: string; // Path to the compiled JS file relative to plugin folder
  dir: string;   // Directory name on server
  /** Optional initial plugin state declared in the plugin's manifest.json. */
  defaultState?: Record<string, unknown>;
}

export const pluginExternalService = {
  async list(): Promise<ExternalPluginManifest[]> {
    const res = await authFetch('/api/plugins-external/external');
    if (!res.ok) throw new Error('Failed to list external plugins');
    return res.json();
  },

  async install(zipFile: File): Promise<{ success: boolean; pluginId: string; name: string }> {
    const buf = await zipFile.arrayBuffer();
    const res = await authFetch('/api/plugins-external/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: buf,
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to install plugin');
    }
    return res.json();
  },

  async delete(id: string): Promise<void> {
    const res = await authFetch(`/api/plugins-external/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete external plugin');
  },
};
