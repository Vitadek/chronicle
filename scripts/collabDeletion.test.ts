import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import { WebSocket } from 'ws';
import * as Y from 'yjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-collab-delete-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'none';

const { db, LOCAL_USER_ID } = await import('../server/db');
const { deleteChapter } = await import('../server/lib/manuscriptRepository');
const { attachCollab, hocuspocus } = await import('../server/collab');
// Hocuspocus retains its idle-auth timer after an onConnect rejection. Keep
// that production timeout short in this isolated process so negative sockets
// do not make the regression test wait 30 seconds to exit.
hocuspocus.configure({ timeout: 250 });

const now = Date.now();
db.prepare(`
  INSERT INTO manuscripts(
    user_id, id, data, last_modified, deleted_at, revision
  ) VALUES (?, 'book', ?, ?, NULL, 1)
`).run(
  LOCAL_USER_ID,
  JSON.stringify({
    id: 'book',
    title: 'Book',
    author: 'Author',
    lastModified: now,
    revision: 1,
  }),
  now,
);
db.prepare(`
  INSERT INTO chapters(
    user_id, manuscript_id, id, title, content, position,
    last_modified, deleted_at, revision
  ) VALUES (?, 'book', 'chapter', 'Chapter', '<p>secret prose</p>', 0, ?, NULL, 1)
`).run(LOCAL_USER_ID, now);

const server = createServer();
const collab = attachCollab(server);
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const address = server.address();
assert(address && typeof address === 'object');
const url = `ws://127.0.0.1:${address.port}/collab`;
const documentName = `${encodeURIComponent(LOCAL_USER_ID)}/book:chapter`;

function testSocket(): HocuspocusProviderWebsocket {
  return new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: WebSocket,
    maxAttempts: 1,
    delay: 10,
    initialDelay: 0,
    factor: 1,
    minDelay: 10,
    maxDelay: 10,
    jitter: false,
    timeout: 1_000,
    quiet: true,
  });
}

function waitFor(predicate: () => boolean, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function destroyProvider(provider: HocuspocusProvider): void {
  // Provider.destroy() detaches from an implicitly-created socket provider but
  // intentionally leaves that provider reusable. Tests own it exclusively, so
  // also destroy it to clear its connection-check interval and retry timer.
  const socketProvider = provider.configuration.websocketProvider;
  provider.destroy();
  socketProvider.destroy();
}

let firstDisconnected = false;
let firstProvider!: HocuspocusProvider;
let rejectedProvider: HocuspocusProvider | null = null;
const firstSynced = new Promise<void>((resolve) => {
  firstProvider = new HocuspocusProvider({
    websocketProvider: testSocket(),
    name: documentName,
    document: new Y.Doc(),
    broadcast: false,
    preserveConnection: false,
    onSynced: () => resolve(),
    onDisconnect: () => {
      firstDisconnected = true;
    },
  });
});

try {
  await Promise.race([
    firstSynced,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('initial collaboration connection did not sync')), 5_000),
    ),
  ]);
  assert(hocuspocus.documents.has(documentName), 'chapter Y.Doc was not loaded');

  const deleted = deleteChapter(LOCAL_USER_ID, 'book', 'chapter', 1);
  assert(deleted?.ok, 'chapter deletion was rejected');

  await waitFor(
    () => firstDisconnected && !hocuspocus.documents.has(documentName),
    'deleted chapter kept a socket or in-memory Y.Doc',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM ydocs').get() as { n: number }).n,
    0,
  );

  // A reconnect after the tombstone must be rejected before Hocuspocus can
  // create or reuse an empty in-memory room for the deleted chapter.
  let rejectedConnectionClosed = false;
  rejectedProvider = new HocuspocusProvider({
    websocketProvider: testSocket(),
    name: documentName,
    document: new Y.Doc(),
    broadcast: false,
    preserveConnection: false,
    onClose: () => {
      rejectedConnectionClosed = true;
    },
  });
  await waitFor(
    () => rejectedConnectionClosed,
    'deleted collaborative chapter accepted a new connection',
  );
  destroyProvider(rejectedProvider);
  rejectedProvider = null;
  assert.equal(hocuspocus.documents.has(documentName), false);

  console.log('PASS deletion closes collaboration sockets and evicts cached prose');
} finally {
  if (rejectedProvider) destroyProvider(rejectedProvider);
  destroyProvider(firstProvider);
  await collab.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
