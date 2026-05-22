import { authFetch } from './authService';

/**
 * Cover art upload + fetch.
 *
 * Server validates the format via magic bytes, so the client only has to
 * pass the raw file. Allowed types: image/png, image/jpeg, image/webp.
 *
 * Cover image serving is auth-gated (the server scopes covers to the
 * authenticated user), so we can't use the filename URL directly in an
 * <img src=...>. Instead we fetch the bytes via authFetch, build a blob
 * URL, and hand that to the UI. The cache below keeps repeat lookups fast.
 */

const blobCache = new Map<string, string>();

export async function uploadCover(manuscriptId: string, file: File): Promise<string> {
  const response = await authFetch(`/api/covers/${encodeURIComponent(manuscriptId)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) {
    let msg = `Upload failed: ${response.status}`;
    try {
      const j = await response.json();
      if (j?.error) msg = j.error;
    } catch { /* */ }
    throw new Error(msg);
  }
  const data = await response.json();
  return data.coverArt as string;
}

export async function deleteCover(manuscriptId: string): Promise<void> {
  await authFetch(`/api/covers/${encodeURIComponent(manuscriptId)}`, {
    method: 'DELETE',
  });
}

/**
 * Fetch a cover image and return a blob URL suitable for <img src=...>.
 * Cached per filename so a re-render doesn't refetch.
 *
 * Returns null if the cover is missing or the request fails — callers can
 * fall back to a placeholder.
 */
export async function loadCoverBlobUrl(filename: string): Promise<string | null> {
  const cached = blobCache.get(filename);
  if (cached) return cached;
  try {
    const res = await authFetch(`/api/covers/${encodeURIComponent(filename)}`);
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    blobCache.set(filename, url);
    return url;
  } catch {
    return null;
  }
}

/** Invalidate the cache for one filename (e.g. after replacing the cover). */
export function clearCoverCache(filename?: string): void {
  if (filename) {
    const url = blobCache.get(filename);
    if (url) URL.revokeObjectURL(url);
    blobCache.delete(filename);
    return;
  }
  // Wipe everything.
  for (const url of blobCache.values()) URL.revokeObjectURL(url);
  blobCache.clear();
}
