import { db } from '../db';
import { config } from '../config';

/**
 * Nextcloud integration. Two independent pieces:
 *
 *  - OAuth2 (oauth.ts) — identity. Optional.
 *  - WebDAV mirror (this file) — write-behind copy of manuscripts + chapters
 *    into the user's Nextcloud so they own readable files.
 *
 * The mirror is fire-and-forget. Sync responses never wait for it and never
 * fail on its account; if Nextcloud is down, the local DB keeps going.
 */

interface NcCreds {
  baseUrl: string;
  ncUser: string;
  accessToken: string;
}

/** Pull the freshest NC creds for a user, refreshing if necessary. */
async function getNcCreds(userId: string): Promise<NcCreds | null> {
  if (!config.nextcloud.enabled) return null;

  const row = db
    .prepare(
      `SELECT s.token, s.nc_access_token, s.nc_refresh_token, s.nc_expires_at,
              u.nc_user_id, u.nc_url
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ? AND s.nc_access_token IS NOT NULL
        ORDER BY s.created_at DESC
        LIMIT 1`,
    )
    .get(userId) as
    | {
        token: string;
        nc_access_token: string;
        nc_refresh_token: string;
        nc_expires_at: number | null;
        nc_user_id: string;
        nc_url: string;
      }
    | undefined;

  if (!row || !row.nc_url || !row.nc_user_id) return null;

  let accessToken = row.nc_access_token;

  // Refresh ~60s before expiry to avoid races.
  if (row.nc_expires_at && row.nc_expires_at < Date.now() + 60_000) {
    const refreshed = await refreshNcToken(row.nc_url, row.nc_refresh_token);
    if (refreshed) {
      accessToken = refreshed.accessToken;
      db.prepare(
        `UPDATE sessions
            SET nc_access_token = ?, nc_refresh_token = ?, nc_expires_at = ?
          WHERE token = ?`,
      ).run(
        refreshed.accessToken,
        refreshed.refreshToken,
        Date.now() + refreshed.expiresInSec * 1000,
        row.token,
      );
    }
  }

  return {
    baseUrl: row.nc_url.replace(/\/$/, ''),
    ncUser: row.nc_user_id,
    accessToken,
  };
}

async function refreshNcToken(
  ncUrl: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresInSec: number } | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.nextcloud.clientId,
    client_secret: config.nextcloud.clientSecret,
  });
  const res = await fetch(
    `${ncUrl.replace(/\/$/, '')}/index.php/apps/oauth2/api/v1/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresInSec: j.expires_in,
  };
}

function davUrl(creds: NcCreds, path: string): string {
  return `${creds.baseUrl}/remote.php/dav/files/${encodeURIComponent(creds.ncUser)}/${path}`;
}

async function ensureCollection(creds: NcCreds, path: string): Promise<void> {
  // MKCOL returns 405 if it already exists — that's fine.
  await fetch(davUrl(creds, path), {
    method: 'MKCOL',
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  }).catch(() => {});
}

async function putFile(
  creds: NcCreds,
  path: string,
  body: string,
  contentType: string,
): Promise<void> {
  const res = await fetch(davUrl(creds, path), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': contentType,
    },
    body,
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`WebDAV PUT ${path} failed: ${res.status}`);
  }
}

async function deleteFile(creds: NcCreds, path: string): Promise<void> {
  await fetch(davUrl(creds, path), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  }).catch(() => {});
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * Public mirror API. Each method is best-effort and silently no-ops if
 * Nextcloud isn't configured for this user.
 *
 * File layout in the user's Nextcloud:
 *   <root>/<manuscript_id>/manuscript.json
 *   <root>/<manuscript_id>/chapters/<chapter_id>.html
 *
 * Filenames use IDs (not titles) so renames/deletes are deterministic.
 * The chapter title is embedded as <h1> inside each file.
 */
export const ncMirror = {
  async manuscript(userId: string, mId: string, data: string): Promise<void> {
    const creds = await getNcCreds(userId);
    if (!creds) return;
    const root = config.nextcloud.mirrorRoot;
    await ensureCollection(creds, root);
    await ensureCollection(creds, `${root}/${mId}`);
    await ensureCollection(creds, `${root}/${mId}/chapters`);
    await putFile(
      creds,
      `${root}/${mId}/manuscript.json`,
      data,
      'application/json',
    );
  },

  async chapter(
    userId: string,
    mId: string,
    cId: string,
    title: string,
    content: string,
  ): Promise<void> {
    const creds = await getNcCreds(userId);
    if (!creds) return;
    const root = config.nextcloud.mirrorRoot;
    await ensureCollection(creds, root);
    await ensureCollection(creds, `${root}/${mId}`);
    await ensureCollection(creds, `${root}/${mId}/chapters`);
    const wrapped = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title || cId)}</title></head>
<body>
<h1>${escapeHtml(title || 'Untitled')}</h1>
${content || ''}
</body>
</html>`;
    await putFile(
      creds,
      `${root}/${mId}/chapters/${cId}.html`,
      wrapped,
      'text/html; charset=utf-8',
    );
  },

  async deleteChapter(userId: string, mId: string, cId: string): Promise<void> {
    const creds = await getNcCreds(userId);
    if (!creds) return;
    await deleteFile(
      creds,
      `${config.nextcloud.mirrorRoot}/${mId}/chapters/${cId}.html`,
    );
  },

  async deleteManuscript(userId: string, mId: string): Promise<void> {
    const creds = await getNcCreds(userId);
    if (!creds) return;
    // Deletes the whole manuscript folder.
    await deleteFile(creds, `${config.nextcloud.mirrorRoot}/${mId}`);
  },
};
