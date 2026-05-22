import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { storage } from '../lib/storage/HybridManager';

const router = Router();

/**
 * Cover art storage.
 *
 * Files live under <DATA_DIR>/covers/<userId>/<storedName>. Stored names
 * include a random suffix so two uploads with the same client filename
 * don't collide, and so a stale image can't be served after replacement
 * (the old file is deleted on replace). The manuscript metadata stores
 * just the basename — no path traversal possible from the client.
 *
 * Three formats accepted: image/png, image/jpeg, image/webp. They're
 * detected from magic bytes, not the Content-Type header (which the
 * client can lie about). Max size is generous for cover art but bounded
 * so a misclick can't fill the volume.
 */

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per cover

type Sniffed = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; ext: 'png' | 'jpg' | 'webp' };

function sniffImage(buf: Buffer): Sniffed | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

function userCoversDir(userId: string): string {
  // Keep userId out of the join in any user-controlled form; we always
  // route through the authenticated req.userId so this is server-trusted.
  return path.join(COVERS_DIR(), userId);
}

/**
 * Upload. POST body is the raw image bytes; the Content-Type header is
 * advisory only — we sniff magic bytes.
 *
 * Body parsed by express.raw at router level (set below) so req.body is a
 * Buffer.
 */
router.post(
  '/:manuscriptId',
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'], limit: MAX_BYTES }),
  async (req, res) => {
    if (!req.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const buf = req.body as unknown as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: 'Empty body' });
      return;
    }
    if (buf.length > MAX_BYTES) {
      res.status(413).json({ error: 'Cover too large (max 8 MB)' });
      return;
    }
    const sniffed = sniffImage(buf);
    if (!sniffed) {
      res.status(415).json({ error: 'Unsupported image type (use PNG, JPEG, or WebP)' });
      return;
    }

    const mId = req.params.manuscriptId;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(mId)) {
      res.status(400).json({ error: 'Invalid manuscript id' });
      return;
    }

    // Wipe any existing cover for this manuscript from the storage
    try {
      const prefix = `covers/${req.userId}/${mId}.`;
      const keys = await storage.list(`covers/${req.userId}/`);
      for (const key of keys) {
        if (key.startsWith(prefix)) {
          await storage.delete(key);
        }
      }
    } catch { /* nothing to clean */ }

    const random = crypto.randomBytes(6).toString('hex');
    const filename = `${mId}.${random}.${sniffed.ext}`;
    const key = `covers/${req.userId}/${filename}`;
    
    await storage.put(key, buf, sniffed.mime);

    // The client stores this in metadata.coverArt. We DON'T include userId
    // in the public URL — the serve handler scopes by the authenticated user.
    res.json({ coverArt: filename, mime: sniffed.mime, bytes: buf.length });
  },
);

/**
 * Serve a cover image. Path is just the filename (which embeds the manuscript
 * id and a random suffix). We scope to the authenticated user's directory so
 * one user can't request another user's covers by guessing filenames.
 */
router.get('/:filename', async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const name = req.params.filename;
  // Reject anything that could escape the user's directory.
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }
  
  const key = `covers/${req.userId}/${name}`;
  const buf = await storage.get(key);
  
  if (!buf) {
    res.status(404).json({ error: 'Cover not found' });
    return;
  }

  const ext = name.split('.').pop()?.toLowerCase();
  const mime =
    ext === 'png' ? 'image/png' :
    ext === 'webp' ? 'image/webp' :
    'image/jpeg';
    
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(buf);
});

router.delete('/:manuscriptId', async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const mId = req.params.manuscriptId;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(mId)) {
    res.status(400).json({ error: 'Invalid manuscript id' });
    return;
  }

  try {
    const prefix = `covers/${req.userId}/${mId}.`;
    const keys = await storage.list(`covers/${req.userId}/`);
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        await storage.delete(key);
      }
    }
  } catch { /* nothing to delete */ }
  res.json({ ok: true });
});

export default router;
