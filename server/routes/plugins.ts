import { Router } from 'express';
import { db } from '../db';
import { z } from 'zod';

const router = Router();

const PluginStateUpdate = z.object({
  pluginId: z.string(),
  manuscriptId: z.string().nullable(),
  enabled: z.boolean(),
  state: z.string(),
  lastModified: z.number(),
});

// List all plugin states for the user
router.get('/', (req, res) => {
  const userId = req.userId!;
  const rows = db.prepare(
    'SELECT id, plugin_id as pluginId, manuscript_id as manuscriptId, enabled, state, last_modified as lastModified FROM plugin_states WHERE user_id = ?'
  ).all(userId) as any[];

  res.json(rows.map(r => ({
    ...r,
    enabled: !!r.enabled
  })));
});

// Update or create a plugin state
router.put('/:id', (req, res) => {
  const userId = req.userId!;
  const { id } = req.params;
  const parsed = PluginStateUpdate.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid plugin state' });
  }

  const { pluginId, manuscriptId, enabled, state, lastModified } = parsed.data;

  db.prepare(`
    INSERT INTO plugin_states (user_id, id, plugin_id, manuscript_id, enabled, state, last_modified)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      plugin_id = excluded.plugin_id,
      manuscript_id = excluded.manuscript_id,
      enabled = excluded.enabled,
      state = excluded.state,
      last_modified = excluded.last_modified
  `).run(userId, id, pluginId, manuscriptId, enabled ? 1 : 0, state, lastModified);

  res.json({ success: true });
});

export default router;
