import { Hocuspocus } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { WebSocketServer } from 'ws';
import type { Server as HttpServer } from 'http';
import crypto from 'crypto';
import * as Y from 'yjs';
import { db, LOCAL_USER_ID } from './db';
import { config } from './config';
import { htmlToYDoc, yDocToHtml } from './collabConvert';

/**
 * Collaborative editing backend (Yjs over WebSocket), sharing the main HTTP
 * server on the /collab path. One Y.Doc per document name (a chapter id); the
 * encoded Y.Doc state is persisted to the `ydocs` SQLite table and is the
 * source of truth for live editing. The legacy /api/manuscripts + export path
 * reads an HTML snapshot derived from the Y.Doc (wired in the migration phase).
 *
 * Testbed: connections are open. OIDC token validation goes in onAuthenticate
 * once Authelia is wired up.
 */

const selectYdoc = db.prepare('SELECT data FROM ydocs WHERE name = ?');
const upsertYdoc = db.prepare(`
  INSERT INTO ydocs (name, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const selectChapter = db.prepare(
  'SELECT content FROM chapters WHERE user_id = ? AND manuscript_id = ? AND id = ? AND deleted_at IS NULL',
);
const updateChapterContent = db.prepare(
  'UPDATE chapters SET content = ?, last_modified = ? WHERE user_id = ? AND manuscript_id = ? AND id = ?',
);
const hasBackup = db.prepare(
  'SELECT 1 FROM chapter_pre_collab WHERE user_id = ? AND manuscript_id = ? AND chapter_id = ?',
);
const insertBackup = db.prepare(
  'INSERT OR IGNORE INTO chapter_pre_collab (user_id, manuscript_id, chapter_id, content, backed_up_at) VALUES (?, ?, ?, ?, ?)',
);

/**
 * Migration seed: when a collaborative document is opened for the first time
 * (no ydocs row yet), build its initial Y.Doc state from the chapter's existing
 * HTML. This is READ-ONLY on the chapters table — it never overwrites prose.
 * Doc name is `${manuscriptId}:${chapterId}`. User is LOCAL_USER_ID for now
 * (none/token mode); OIDC will supply the real user via the connection context.
 */
function seedFromChapter(documentName: string, userId: string): Uint8Array | null {
  const idx = documentName.indexOf(':');
  if (idx === -1) return null;
  const manuscriptId = documentName.slice(0, idx);
  const chapterId = documentName.slice(idx + 1);
  const row = selectChapter.get(userId, manuscriptId, chapterId) as
    | { content: string }
    | undefined;
  if (!row || !row.content) return null;
  try {
    return Y.encodeStateAsUpdate(htmlToYDoc(row.content));
  } catch (e) {
    console.warn('[collab] seed failed for', documentName, e);
    return null;
  }
}

/**
 * Snapshot the live Y.Doc back to the chapter's HTML so /api/manuscripts +
 * export stay current. Reconstructs the Y.Doc from the stored state, renders
 * HTML, and writes it back only when it actually differs — backing up the
 * chapter's original HTML once before the first overwrite, so pre-collab prose
 * is always recoverable. (The first open normalizes markup once with identical
 * content; afterward only real edits write.)
 */
function snapshotToChapter(documentName: string, state: Uint8Array, userId: string): void {
  const idx = documentName.indexOf(':');
  if (idx === -1) return;
  const manuscriptId = documentName.slice(0, idx);
  const chapterId = documentName.slice(idx + 1);
  const row = selectChapter.get(userId, manuscriptId, chapterId) as
    | { content: string }
    | undefined;
  if (!row) return;
  let html: string;
  try {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, state);
    html = yDocToHtml(ydoc);
  } catch (e) {
    console.warn('[collab] snapshot render failed for', documentName, e);
    return;
  }
  if (!html || html === row.content) return;
  if (!hasBackup.get(userId, manuscriptId, chapterId)) {
    insertBackup.run(userId, manuscriptId, chapterId, row.content, Date.now());
  }
  updateChapterContent.run(html, Date.now(), userId, manuscriptId, chapterId);
}

const selectSession = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?');

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Resolve a collab connection's user from its bearer token, mirroring the REST
 * API's auth modes (server/auth.ts). Returns null to reject the connection.
 */
function resolveCollabUser(token?: string): string | null {
  switch (config.auth.mode) {
    case 'none':
      return LOCAL_USER_ID;
    case 'token':
      return token && timingSafeEq(token, config.auth.token) ? LOCAL_USER_ID : null;
    case 'oidc': {
      if (!token) return null;
      const row = selectSession.get(token) as { user_id: string; expires_at: number } | undefined;
      return row && row.expires_at >= Date.now() ? row.user_id : null;
    }
    case 'forward':
      // The collab WS isn't behind the proxy's forward-auth here; treat as the
      // single local user. Revisit if collab is exposed through the proxy.
      return LOCAL_USER_ID;
    default:
      return null;
  }
}

// In token/oidc mode the collab socket requires a valid token; in none/forward
// it stays open (forward is gated at the proxy). Setting onAuthenticate makes
// Hocuspocus require the client to present a token.
const collabNeedsAuth = config.auth.mode === 'token' || config.auth.mode === 'oidc';

function userIdOf(data: unknown): string {
  return ((data as { context?: { userId?: string } }).context?.userId) ?? LOCAL_USER_ID;
}

export const hocuspocus = new Hocuspocus({
  name: 'chronicle-collab',
  ...(collabNeedsAuth
    ? {
        onAuthenticate: async (data: { token?: string }) => {
          const userId = resolveCollabUser(data.token);
          if (!userId) throw new Error('Unauthorized');
          return { userId };
        },
      }
    : {}),
  extensions: [
    new Database({
      fetch: async (data) => {
        const row = selectYdoc.get(data.documentName) as { data: Buffer } | undefined;
        if (row) return new Uint8Array(row.data);
        // First open: seed (read-only) from the chapter's HTML so existing
        // prose appears in the collaborative editor.
        return seedFromChapter(data.documentName, userIdOf(data));
      },
      store: async (data) => {
        upsertYdoc.run(data.documentName, Buffer.from(data.state), Date.now());
        snapshotToChapter(data.documentName, data.state, userIdOf(data));
      },
    }),
  ],
});

/** Wire the collab WebSocket endpoint onto the shared HTTP server at /collab. */
export function attachCollab(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, request) => {
    // Cast: ws's IncomingMessage vs Hocuspocus's Request differ only by http
    // type identity across packages; runtime is the same object.
    hocuspocus.handleConnection(ws, request as unknown as Parameters<typeof hocuspocus.handleConnection>[1]);
  });
  server.on('upgrade', (request, socket, head) => {
    // Only claim /collab; leave other upgrades (e.g. Vite HMR in dev) alone.
    if (!request.url || !request.url.startsWith('/collab')) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
}
