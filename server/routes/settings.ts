import { Router } from 'express';
import { storage } from '../lib/storage/HybridManager';

const router = Router();

/**
 * Per-user settings blob.
 *
 * The client keeps preferences (theme, editor toggles, export settings, …) in
 * localStorage for instant reads, but localStorage is per-browser and the
 * browser may evict it — so users saw preferences "reset" after updates or on
 * a second device. This stores the same key/value map server-side, keyed by
 * the authenticated user; the client hydrates from here at boot and pushes
 * (debounced) on change. Stored through the storage layer, so hybrid mode
 * mirrors it to Nextcloud like everything else.
 *
 * The value is an opaque map of localStorage-style string pairs; the client
 * decides which keys participate (see src/lib/settingsSync.ts).
 */

// Preferences are small; anything past this is a bug or abuse.
const MAX_BYTES = 128 * 1024;

router.get('/', async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const buf = await storage.get(`settings/${req.userId}`);
  if (!buf) {
    res.json({ settings: null });
    return;
  }
  try {
    res.json({ settings: JSON.parse(buf.toString('utf8')) });
  } catch {
    // Corrupt blob: treat as absent rather than wedging the client forever.
    res.json({ settings: null });
  }
});

router.put('/', async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const settings = req.body?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    res.status(400).json({ error: 'Body must be { settings: { key: value, ... } }' });
    return;
  }
  // localStorage mirrors are strings; reject anything else outright.
  for (const [k, v] of Object.entries(settings)) {
    if (typeof v !== 'string') {
      res.status(400).json({ error: `Setting "${k}" must be a string` });
      return;
    }
  }
  const json = JSON.stringify(settings);
  if (json.length > MAX_BYTES) {
    res.status(413).json({ error: 'Settings too large' });
    return;
  }
  // Store as a Buffer, not a string: SQLiteProvider.get() guesses base64 for
  // space-free strings, which would garble compact JSON on read. Buffers
  // round-trip through its base64 encoding deterministically.
  await storage.put(`settings/${req.userId}`, Buffer.from(json, 'utf8'), 'application/json');
  res.json({ ok: true });
});

export default router;
