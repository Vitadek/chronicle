import { Manuscript, ManuscriptMetadata } from '../types';
import { authFetch } from './authService';

export const manuscriptService = {
  async list(): Promise<ManuscriptMetadata[]> {
    const res = await authFetch('/api/manuscripts');
    if (!res.ok) throw new Error('Failed to list manuscripts');
    return res.json();
  },

  async get(id: string): Promise<Manuscript> {
    const res = await authFetch(`/api/manuscripts/${id}`);
    if (!res.ok) throw new Error('Manuscript not found');
    return res.json();
  },

  async create(manuscript: Manuscript): Promise<Manuscript> {
    const res = await authFetch('/api/manuscripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manuscript),
    });
    if (!res.ok) throw new Error('Failed to create manuscript');
    return res.json();
  },

  async update(id: string, manuscript: Manuscript): Promise<Manuscript> {
    const res = await authFetch(`/api/manuscripts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manuscript),
    });
    if (!res.ok) throw new Error('Failed to save manuscript');
    return res.json();
  },

  async delete(id: string): Promise<void> {
    const res = await authFetch(`/api/manuscripts/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete manuscript');
  },
};
