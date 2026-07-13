import { assert, eventually } from './harness.mjs';

export const baseUrl = process.env.CHRONICLE_URL || 'http://chronicle:3000';
export const forwardSecret = process.env.FORWARD_SECRET || 'chronicle-formal-forward-secret';

export function authHeaders(user = 'alice') {
  return {
    'Remote-User': user,
    'Remote-Name': `Formal ${user}`,
    'X-Formal-Secret': forwardSecret,
  };
}

export async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.user) {
    for (const [key, value] of Object.entries(authHeaders(options.user))) headers.set(key, value);
  }
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || (options.json === undefined ? 'GET' : 'POST'),
    headers,
    body: options.json === undefined ? options.body : JSON.stringify(options.json),
    redirect: options.redirect || 'manual',
  });
  const contentType = response.headers.get('content-type') || '';
  const bytes = Buffer.from(await response.arrayBuffer());
  let data = null;
  if (contentType.includes('json') && bytes.length) {
    data = JSON.parse(bytes.toString('utf8'));
  }
  return { response, status: response.status, headers: response.headers, bytes, data };
}

export async function expectStatus(path, status, options = {}) {
  const result = await request(path, options);
  assert.equal(result.status, status, `${options.method || 'GET'} ${path}: ${result.bytes.toString('utf8')}`);
  return result;
}

export async function userIdentity(user) {
  const result = await expectStatus('/api/auth/me', 200, { user });
  assert.equal(result.data.authVia, 'forward');
  assert.equal(typeof result.data.id, 'string');
  return result.data;
}

export async function waitReady(predicate = (body) => body.ready, label = 'Chronicle readiness') {
  return eventually(async () => {
    const result = await request('/readyz');
    if (result.status !== 200 || !result.data || !predicate(result.data)) return false;
    return result.data;
  }, { timeoutMs: 30_000, intervalMs: 200, label });
}

export function manuscript(id, title, chapters, overrides = {}) {
  const now = overrides.lastModified ?? Date.now();
  return {
    metadata: {
      id,
      title,
      author: overrides.author ?? 'Zoë Formal 🖋️',
      lastModified: now,
      ...(overrides.revision ? { revision: overrides.revision } : {}),
    },
    chapters: chapters.map((chapter, index) => ({
      id: chapter.id,
      title: chapter.title,
      content: chapter.content,
      lastModified: chapter.lastModified ?? now,
      ...(chapter.revision ? { revision: chapter.revision } : {}),
      position: index,
    })),
  };
}

export async function waitManuscript(user, id, predicate, label = id) {
  return eventually(async () => {
    const result = await request(`/api/manuscripts/${id}`, { user });
    if (result.status !== 200 || !predicate(result.data)) return false;
    return result.data;
  }, { timeoutMs: 20_000, intervalMs: 100, label: `manuscript ${label}` });
}
