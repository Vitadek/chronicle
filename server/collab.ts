import { Hocuspocus } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { WebSocketServer } from 'ws';
import type { Server as HttpServer } from 'http';
import crypto from 'crypto';
import * as Y from 'yjs';
import { db, LOCAL_USER_ID } from './db';
import { config } from './config';
import { htmlToYDoc, yDocToHtml } from './collabConvert';
import {
  purgeChapterCollaborationResidue,
  recordChange,
  touchManuscriptForChapterChange,
} from './lib/manuscriptRepository';
import { enqueueChapterReplica } from './lib/portableReplica';
import { persistCollaborativeStateIfLive } from './lib/collabPersistence';
import {
  registerCollaborationEvictor,
  type CollaborationEvictionTarget,
} from './lib/collabEviction';
import { resolveForwardUser } from './auth';

/**
 * Collaborative editing backend (Yjs over WebSocket), sharing the main HTTP
 * server on the /collab path. One Y.Doc per document name (a chapter id); the
 * encoded Y.Doc state is persisted to the `ydocs` SQLite table and is the
 * source of truth for live editing. The legacy /api/manuscripts + export path
 * reads an HTML snapshot derived from the Y.Doc (wired in the migration phase).
 *
 * Every document name is scoped by the server-verified user id. Token/OIDC
 * sockets authenticate in Hocuspocus; forward-auth sockets reuse the REST
 * trusted-proxy resolver.
 */

const selectYdoc = db.prepare('SELECT data FROM ydocs WHERE name = ?');
const upsertYdoc = db.prepare(`
  INSERT INTO ydocs (name, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const selectChapter = db.prepare(
  `SELECT title, content, position, revision FROM chapters
    WHERE user_id = ? AND manuscript_id = ? AND id = ? AND deleted_at IS NULL`,
);
const updateChapterContent = db.prepare(
  `UPDATE chapters
      SET content = ?, last_modified = ?, revision = ?
    WHERE user_id = ? AND manuscript_id = ? AND id = ?`,
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
 * Document names are `<encoded-user>/<manuscript>:<chapter>`.
 */
interface ScopedDocumentName {
  userId: string;
  manuscriptId: string;
  chapterId: string;
  legacyName: string;
}

function parseDocumentName(documentName: string): ScopedDocumentName | null {
  if (documentName.length > 260) return null;
  const slash = documentName.indexOf('/');
  const colon = documentName.indexOf(':', slash + 1);
  if (slash <= 0 || colon <= slash + 1) return null;
  let userId: string;
  try {
    userId = decodeURIComponent(documentName.slice(0, slash));
  } catch {
    return null;
  }
  const manuscriptId = documentName.slice(slash + 1, colon);
  const chapterId = documentName.slice(colon + 1);
  const safeId = /^[A-Za-z0-9_-]{1,64}$/;
  if (!userId || !safeId.test(manuscriptId) || !safeId.test(chapterId)) return null;
  return { userId, manuscriptId, chapterId, legacyName: `${manuscriptId}:${chapterId}` };
}

function assertDocumentOwner(documentName: string, userId: string): ScopedDocumentName {
  const parsed = parseDocumentName(documentName);
  if (!parsed || parsed.userId !== userId) throw new Error('Unauthorized document scope');
  return parsed;
}

function assertLiveDocumentOwner(
  documentName: string,
  userId: string,
): ScopedDocumentName {
  const parsed = assertDocumentOwner(documentName, userId);
  if (!selectChapter.get(userId, parsed.manuscriptId, parsed.chapterId)) {
    purgeChapterCollaborationResidue(
      userId,
      parsed.manuscriptId,
      parsed.chapterId,
    );
    throw new Error('Collaborative chapter no longer exists');
  }
  return parsed;
}

function seedFromChapter(documentName: string, userId: string): Uint8Array | null {
  const parsed = assertDocumentOwner(documentName, userId);
  const { manuscriptId, chapterId } = parsed;
  const row = selectChapter.get(userId, manuscriptId, chapterId) as
    | { content: string | null }
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
  const parsed = assertDocumentOwner(documentName, userId);
  const { manuscriptId, chapterId } = parsed;
  const row = selectChapter.get(userId, manuscriptId, chapterId) as
    | { title: string | null; content: string | null; position: number | null; revision: number }
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
  const previousContent = row.content ?? '';
  if (!html || html === previousContent) return;
  const now = Date.now();
  const revision = row.revision + 1;
  db.transaction(() => {
    if (!hasBackup.get(userId, manuscriptId, chapterId)) {
      insertBackup.run(userId, manuscriptId, chapterId, previousContent, now);
    }
    updateChapterContent.run(
      html,
      now,
      revision,
      userId,
      manuscriptId,
      chapterId,
    );
    recordChange(
      userId,
      'chapter',
      manuscriptId,
      chapterId,
      'upsert',
      revision,
      now,
    );
    enqueueChapterReplica(
      userId,
      manuscriptId,
      chapterId,
      row.title ?? '',
      html,
      row.position ?? 0,
      now,
      revision,
    );
    touchManuscriptForChapterChange(userId, manuscriptId, now);
  })();
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
  stopOnSignals: false,
  onConnect: async (data) => {
    if (config.auth.mode === 'none') {
      assertLiveDocumentOwner(data.documentName, LOCAL_USER_ID);
      return { userId: LOCAL_USER_ID };
    }
    if (config.auth.mode === 'forward') {
      const identity = resolveForwardUser(data.request);
      if (identity.ok === false) throw new Error(identity.error);
      assertLiveDocumentOwner(data.documentName, identity.userId);
      return { userId: identity.userId };
    }
    // Token/OIDC identity is resolved by onAuthenticate, but reject malformed
    // document names before holding any connection state.
    if (!parseDocumentName(data.documentName)) throw new Error('Invalid document scope');
    return {};
  },
  ...(collabNeedsAuth
    ? {
        onAuthenticate: async (data: { token?: string; documentName: string }) => {
          const userId = resolveCollabUser(data.token);
          if (!userId) throw new Error('Unauthorized');
          assertLiveDocumentOwner(data.documentName, userId);
          return { userId };
        },
      }
    : {}),
  extensions: [
    new Database({
      fetch: async (data) => {
        const userId = userIdOf(data);
        const scoped = assertDocumentOwner(data.documentName, userId);
        // A retained chapter tombstone is terminal. Never serve a stale Y.Doc
        // that survived an older build's delete path.
        if (!selectChapter.get(userId, scoped.manuscriptId, scoped.chapterId)) {
          purgeChapterCollaborationResidue(
            userId,
            scoped.manuscriptId,
            scoped.chapterId,
          );
          return null;
        }
        const row = selectYdoc.get(data.documentName) as { data: Buffer } | undefined;
        if (row) return new Uint8Array(row.data);
        // Preserve the single-user preview's existing collaborative state while
        // moving all new rows to user-scoped names.
        if (userId === LOCAL_USER_ID) {
          const legacy = selectYdoc.get(scoped.legacyName) as { data: Buffer } | undefined;
          if (legacy) {
            upsertYdoc.run(data.documentName, legacy.data, Date.now());
            return new Uint8Array(legacy.data);
          }
        }
        // First open: seed (read-only) from the chapter's HTML so existing
        // prose appears in the collaborative editor.
        return seedFromChapter(data.documentName, userId);
      },
      store: async (data) => {
        const userId = userIdOf(data);
        const scoped = assertDocumentOwner(data.documentName, userId);
        // A store callback can arrive after a REST/sync delete from a client
        // that was already connected. Re-check live ownership before writing,
        // or that late callback would recreate both Yjs and snapshot prose.
        if (!persistCollaborativeStateIfLive(
          data.documentName,
          data.state,
          userId,
          scoped.manuscriptId,
          scoped.chapterId,
        )) return;
        snapshotToChapter(data.documentName, data.state, userId);
      },
    }),
  ],
});

const evictionsInFlight = new Set<string>();

function loadedDocumentNames(target: CollaborationEvictionTarget): string[] {
  const scopedPrefix = `${encodeURIComponent(target.userId)}/${target.manuscriptId}:`;
  const legacyPrefix = `${target.manuscriptId}:`;
  if (target.chapterId) {
    return [
      `${scopedPrefix}${target.chapterId}`,
      `${legacyPrefix}${target.chapterId}`,
    ];
  }
  return [...hocuspocus.documents.keys()].filter(
    (name) => name.startsWith(scopedPrefix) || name.startsWith(legacyPrefix),
  );
}

registerCollaborationEvictor((target) => {
  for (const documentName of loadedDocumentNames(target)) {
    if (evictionsInFlight.has(documentName)) continue;
    const document = hocuspocus.documents.get(documentName);
    if (!document) continue;
    evictionsInFlight.add(documentName);
    // closeConnections removes each socket from the Y.Doc synchronously. Once
    // the last connection is gone, unloading destroys the in-memory prose and
    // removes the cache entry so no later connection can inherit it.
    hocuspocus.closeConnections(documentName);
    void hocuspocus.unloadDocument(document)
      .catch((error) => {
        console.error('[collab] failed to evict deleted document', documentName, error);
      })
      .finally(() => evictionsInFlight.delete(documentName));
  }
});

export interface CollabHandle {
  close(): Promise<void>;
}

/** Wire the collab WebSocket endpoint onto the shared HTTP server at /collab. */
export function attachCollab(server: HttpServer): CollabHandle {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, request) => {
    // Cast: ws's IncomingMessage vs Hocuspocus's Request differ only by http
    // type identity across packages; runtime is the same object.
    hocuspocus.handleConnection(ws, request as unknown as Parameters<typeof hocuspocus.handleConnection>[1]);
  });
  server.on('upgrade', (request, socket, head) => {
    // Only claim /collab; leave other upgrades (e.g. Vite HMR in dev) alone.
    if (!request.url) return;
    let pathname: string;
    try {
      pathname = new URL(request.url, 'http://chronicle.local').pathname;
    } catch {
      return;
    }
    if (pathname !== '/collab') return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
  return {
    async close() {
      // Hocuspocus flushes any debounced document stores while closing its
      // connections. Closing the standalone WebSocketServer then prevents new
      // upgrades from being accepted during process shutdown.
      await hocuspocus.destroy();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
