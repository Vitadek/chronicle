import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { authHeaders, baseUrl } from './api.mjs';
import { eventually } from './harness.mjs';

const wsUrl = baseUrl.replace(/^http/, 'ws') + '/collab';

function polyfillFor(user, includeHeaders = true) {
  const headers = includeHeaders ? authHeaders(user) : {};
  return class FormalWebSocket extends WebSocket {
    constructor(url) {
      super(url, { headers });
    }
  };
}

export async function connectDocument({ user, documentName, includeHeaders = true }) {
  const document = new Y.Doc();
  let authFailure = null;
  const socket = new HocuspocusProviderWebsocket({
    url: wsUrl,
    WebSocketPolyfill: polyfillFor(user, includeHeaders),
    connect: true,
    maxAttempts: 1,
    timeout: 5_000,
    quiet: true,
  });
  const provider = new HocuspocusProvider({
    name: documentName,
    document,
    websocketProvider: socket,
    broadcast: false,
    preserveConnection: false,
    quiet: true,
    onAuthenticationFailed: ({ reason }) => {
      authFailure = reason || 'authentication failed';
    },
  });
  await eventually(() => provider.synced || authFailure, {
    timeoutMs: 10_000,
    intervalMs: 50,
    label: `collaboration handshake for ${documentName}`,
  });
  return { document, provider, socket, authFailure: () => authFailure };
}

export async function expectDenied(options) {
  const connection = await connectDocument(options).catch((error) => ({ error }));
  if (connection.error) return true;
  try {
    await eventually(
      () => connection.authFailure() || (!connection.provider.isConnected && !connection.provider.synced),
      { timeoutMs: 5_000, intervalMs: 50, label: 'collaboration rejection' },
    );
    return true;
  } finally {
    connection.provider.destroy();
    connection.socket.destroy();
    connection.document.destroy();
  }
}

export async function convergeMap(left, right, key, value) {
  left.document.getMap('formal').set(key, value);
  return eventually(() => right.document.getMap('formal').get(key) === value, {
    timeoutMs: 10_000,
    intervalMs: 50,
    label: 'two-client Yjs convergence',
  });
}

export function closeConnection(connection) {
  connection.provider.destroy();
  connection.socket.destroy();
  connection.document.destroy();
}
