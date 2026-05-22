import { PluginStateRecord } from '../types';
import { authFetch } from './authService';

export const pluginService = {
  async list(): Promise<PluginStateRecord[]> {
    const res = await authFetch('/api/plugins');
    if (!res.ok) throw new Error('Failed to list plugins');
    return res.json();
  },

  async update(id: string, record: Partial<PluginStateRecord>): Promise<void> {
    const res = await authFetch(`/api/plugins/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!res.ok) throw new Error('Failed to update plugin state');
  },
};
