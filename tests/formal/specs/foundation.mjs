import crypto from 'node:crypto';
import {
  assert,
  eventually,
  runSuite,
} from '../lib/harness.mjs';
import {
  authHeaders,
  expectStatus,
  manuscript,
  request,
  userIdentity,
  waitReady,
} from '../lib/api.mjs';
import {
  assertChronicleMetadata,
  getObject,
  headObject,
  listObjects,
  waitObject,
  waitObjectAbsent,
} from '../lib/s3.mjs';
import {
  closeConnection,
  connectDocument,
  convergeMap,
  expectDenied,
} from '../lib/collab.mjs';

const alice = 'alice';
const bob = 'bob';
let aliceId;
let bobId;
let durable;
let coverName;
let collabDocumentName;

function portable(userId, suffix) {
  return `v1/users/${encodeURIComponent(userId)}/${suffix}`;
}

function parseChapterEnvelope(bytes) {
  const text = bytes.toString('utf8');
  const encoded = /data-chronicle-record="([A-Za-z0-9_-]+)"/.exec(text)?.[1];
  assert.ok(encoded, 'portable chapter metadata marker must exist');
  return {
    text,
    metadata: JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
  };
}

export async function run() {
  await runSuite('formal-foundation', async (test) => {
    test('health endpoint is unauthenticated and reports a timestamp', async () => {
      const result = await expectStatus('/healthz', 200);
      assert.equal(result.data.ok, true);
      assert.equal(Number.isSafeInteger(result.data.time), true);
    });

    test('readiness reports SQLite and healthy S3 without leaking endpoint details', async () => {
      const body = await waitReady((value) => value.replica?.state === 'healthy');
      assert.equal(body.database, 'ready');
      assert.equal(body.replica.provider, 's3');
      assert.equal(Object.hasOwn(body.replica, 'lastError'), false);
      assert.equal(JSON.stringify(body).includes('toxiproxy'), false);
    });

    test('public auth config identifies forward mode without credentials', async () => {
      const result = await expectStatus('/api/auth/config', 200);
      assert.equal(result.data.mode, 'forward');
    });

    test('SPA shell remains publicly loadable in authenticated mode', async () => {
      const result = await expectStatus('/', 200);
      assert.match(result.headers.get('content-type') || '', /text\/html/);
      assert.match(result.bytes.toString('utf8'), /<div id="root"><\/div>/);
      assert.equal(result.headers.get('cache-control'), 'no-cache');
    });

    test('hashed static assets use immutable caching', async () => {
      const shell = await request('/');
      const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(shell.bytes.toString('utf8'))?.[1];
      assert.ok(asset, 'index must reference a hashed asset');
      const result = await expectStatus(asset, 200);
      assert.match(result.headers.get('cache-control') || '', /immutable/);
    });

    test('protected API rejects a request without proxy authentication', async () => {
      const result = await expectStatus('/api/manuscripts', 403);
      assert.match(result.data.error, /secret/i);
    });

    test('protected API rejects a bad forward shared secret', async () => {
      const headers = authHeaders(alice);
      headers['X-Formal-Secret'] = 'incorrect';
      const result = await expectStatus('/api/manuscripts', 403, { headers });
      assert.match(result.data.error, /secret/i);
    });

    test('forward identities produce distinct durable local users', async () => {
      const [a, b] = await Promise.all([userIdentity(alice), userIdentity(bob)]);
      aliceId = a.id;
      bobId = b.id;
      assert.notEqual(aliceId, bobId);
      assert.equal(a.display_name, 'Formal alice');
      assert.equal(b.display_name, 'Formal bob');
    });

    test('unknown API routes are JSON 404 responses', async () => {
      const result = await expectStatus('/api/definitely-not-a-route', 404, { user: alice });
      assert.match(result.headers.get('content-type') || '', /json/);
      assert.equal(result.data.error, 'API endpoint not found');
    });

    test('empty grammar checks avoid the sidecar and return no hits', async () => {
      const result = await expectStatus('/api/grammar/check', 200, {
        user: alice,
        json: { text: '   ' },
      });
      assert.deepEqual(result.data, { hits: [] });
    });

    test('LanguageTool fixture is mapped to Chronicle hit shape deterministically', async () => {
      const result = await expectStatus('/api/grammar/check', 200, {
        user: alice,
        json: { text: 'Fix teh sentence.' },
      });
      assert.deepEqual(result.data.hits, [{
        start: 4,
        end: 7,
        kind: 'misspelling',
        message: 'Possible spelling mistake found by the formal fixture.',
        replacements: ['the', 'ten'],
      }]);
    });

    test('Unicode manuscript and chapters are created with server revisions', async () => {
      const input = manuscript('formal_unicode', '海辺の Chronicle — 🖋️', [
        { id: 'alpha', title: 'Café α', content: '<p>naïve 東京 🌊 — secret prose</p>' },
        { id: 'beta', title: 'مرحبا', content: '<p>Здравствуй мир</p>' },
      ]);
      const result = await expectStatus('/api/manuscripts', 201, { user: alice, json: input });
      assert.equal(result.data.metadata.title, input.metadata.title);
      assert.equal(result.data.chapters[0].content, input.chapters[0].content);
      assert.ok(result.data.metadata.revision >= 2);
      assert.equal(result.data.chapters[0].revision, 1);
      assert.equal(result.data.chapters[1].revision, 1);
    });

    test('manuscript GET round-trips exact Unicode content', async () => {
      const result = await expectStatus('/api/manuscripts/formal_unicode', 200, { user: alice });
      assert.equal(result.data.metadata.author, 'Zoë Formal 🖋️');
      assert.equal(result.data.chapters[0].content, '<p>naïve 東京 🌊 — secret prose</p>');
      assert.equal(result.data.chapters[1].title, 'مرحبا');
    });

    test('library listing includes metadata but not embedded chapters', async () => {
      const result = await expectStatus('/api/manuscripts', 200, { user: alice });
      const entry = result.data.find((item) => item.id === 'formal_unicode');
      assert.ok(entry);
      assert.equal(Object.hasOwn(entry, 'chapters'), false);
      assert.equal(typeof entry.revision, 'number');
    });

    test('another user cannot list or load Alice manuscripts', async () => {
      const [list, get] = await Promise.all([
        expectStatus('/api/manuscripts', 200, { user: bob }),
        expectStatus('/api/manuscripts/formal_unicode', 404, { user: bob }),
      ]);
      assert.equal(list.data.some((item) => item.id === 'formal_unicode'), false);
      assert.equal(get.data.error, 'Manuscript not found');
    });

    test('create-only manuscript POST rejects a duplicate id', async () => {
      const current = (await request('/api/manuscripts/formal_unicode', { user: alice })).data;
      const result = await expectStatus('/api/manuscripts', 409, { user: alice, json: current });
      assert.equal(result.data.conflicts[0].reason, 'already-exists');
    });

    test('whole-manuscript PUT accepts a matching chapter revision', async () => {
      const current = (await request('/api/manuscripts/formal_unicode', { user: alice })).data;
      current.chapters[0].content = '<p>Fresh revision ✅</p>';
      const result = await expectStatus('/api/manuscripts/formal_unicode', 200, {
        user: alice,
        method: 'PUT',
        json: current,
      });
      assert.equal(result.data.chapters[0].revision, 2);
      assert.equal(result.data.chapters[0].content, '<p>Fresh revision ✅</p>');
    });

    test('same-chapter stale revision is a 409 with authoritative content', async () => {
      const current = (await request('/api/manuscripts/formal_unicode', { user: alice })).data;
      const stale = structuredClone(current);
      stale.chapters[0].revision -= 1;
      stale.chapters[0].content = '<p>stale overwrite</p>';
      const result = await expectStatus('/api/manuscripts/formal_unicode', 409, {
        user: alice,
        method: 'PUT',
        json: stale,
      });
      assert.ok(result.data.conflicts.some((conflict) => conflict.entity === 'chapter'));
      assert.equal(result.data.manuscript.chapters[0].content, '<p>Fresh revision ✅</p>');
    });

    test('unchanged replay is idempotent and does not advance revisions', async () => {
      const before = (await request('/api/manuscripts/formal_unicode', { user: alice })).data;
      const result = await expectStatus('/api/manuscripts/formal_unicode', 200, {
        user: alice,
        method: 'PUT',
        json: before,
      });
      assert.equal(result.data.metadata.revision, before.metadata.revision);
      assert.deepEqual(result.data.chapters.map((c) => c.revision), before.chapters.map((c) => c.revision));
    });

    test('chapter DELETE enforces its base revision', async () => {
      const current = (await request('/api/manuscripts/formal_unicode', { user: alice })).data;
      const beta = current.chapters.find((chapter) => chapter.id === 'beta');
      const conflict = await expectStatus('/api/manuscripts/formal_unicode/chapters/beta', 409, {
        user: alice,
        method: 'DELETE',
        json: { baseRevision: beta.revision + 50 },
      });
      assert.equal(conflict.data.currentRevision, beta.revision);
    });

    test('chapter DELETE is idempotent and advances aggregate manuscript revision once', async () => {
      const before = (await request('/api/manuscripts/formal_unicode', { user: alice })).data;
      const beta = before.chapters.find((chapter) => chapter.id === 'beta');
      const first = await expectStatus('/api/manuscripts/formal_unicode/chapters/beta', 200, {
        user: alice,
        method: 'DELETE',
        json: { baseRevision: beta.revision },
      });
      const second = await expectStatus('/api/manuscripts/formal_unicode/chapters/beta', 200, {
        user: alice,
        method: 'DELETE',
        json: { baseRevision: beta.revision },
      });
      assert.equal(second.data.revision, first.data.revision);
      assert.equal(second.data.manuscriptRevision, first.data.manuscriptRevision);
      const after = (await request('/api/manuscripts/formal_unicode', { user: alice })).data;
      assert.equal(after.chapters.some((chapter) => chapter.id === 'beta'), false);
      assert.equal(after.metadata.revision, first.data.manuscriptRevision);
    });

    test('manuscript DELETE rejects a stale aggregate revision', async () => {
      const current = (await request('/api/manuscripts/formal_unicode', { user: alice })).data;
      const result = await expectStatus('/api/manuscripts/formal_unicode', 409, {
        user: alice,
        method: 'DELETE',
        json: { baseRevision: current.metadata.revision - 1 },
      });
      assert.equal(result.data.currentRevision, current.metadata.revision);
    });

    test('manuscript DELETE is idempotent and removes the live representation', async () => {
      const current = (await request('/api/manuscripts/formal_unicode', { user: alice })).data;
      await expectStatus('/api/manuscripts/formal_unicode', 204, {
        user: alice,
        method: 'DELETE',
        json: { baseRevision: current.metadata.revision },
      });
      await expectStatus('/api/manuscripts/formal_unicode', 204, {
        user: alice,
        method: 'DELETE',
        json: { baseRevision: current.metadata.revision },
      });
      await expectStatus('/api/manuscripts/formal_unicode', 404, { user: alice });
    });

    test('sync v2 accepts different-chapter changes from one common snapshot', async () => {
      const create = await expectStatus('/api/sync/v2', 200, {
        user: alice,
        json: {
          cursor: 0,
          changes: [
            { entity: 'manuscript', operation: 'upsert', id: 'formal_v2', baseRevision: 0, data: JSON.stringify({ id: 'formal_v2', title: 'V2', author: 'Formal', lastModified: 1 }) },
            { entity: 'chapter', operation: 'upsert', manuscriptId: 'formal_v2', id: 'one', baseRevision: 0, title: 'One', content: '<p>one</p>', position: 0 },
            { entity: 'chapter', operation: 'upsert', manuscriptId: 'formal_v2', id: 'two', baseRevision: 0, title: 'Two', content: '<p>two</p>', position: 1 },
          ],
        },
      });
      assert.equal(create.data.results.every((result) => result.status === 'accepted'), true);
      const update = await expectStatus('/api/sync/v2', 200, {
        user: alice,
        json: {
          cursor: create.data.cursor,
          changes: [
            { entity: 'chapter', operation: 'upsert', manuscriptId: 'formal_v2', id: 'one', baseRevision: 1, title: 'One A', content: '<p>device A</p>', position: 0 },
            { entity: 'chapter', operation: 'upsert', manuscriptId: 'formal_v2', id: 'two', baseRevision: 1, title: 'Two B', content: '<p>device B</p>', position: 1 },
          ],
        },
      });
      assert.deepEqual(update.data.results.map((result) => result.status), ['accepted', 'accepted']);
      assert.deepEqual(update.data.results.map((result) => result.revision), [2, 2]);
    });

    test('sync v2 same-chapter stale base returns current authoritative revision', async () => {
      const result = await expectStatus('/api/sync/v2', 200, {
        user: alice,
        json: {
          cursor: 0,
          changes: [{ entity: 'chapter', operation: 'upsert', manuscriptId: 'formal_v2', id: 'one', baseRevision: 1, title: 'Stale', content: '<p>stale</p>', position: 0 }],
        },
      });
      assert.equal(result.data.results[0].status, 'conflict');
      assert.equal(result.data.results[0].revision, 2);
      assert.equal(result.data.results[0].current.content, '<p>device A</p>');
    });

    test('sync v2 resets a cursor ahead of restored server history', async () => {
      const baseline = await expectStatus('/api/sync/v2', 200, {
        user: alice,
        json: { cursor: 0, changes: [] },
      });
      const supportsEpoch = typeof baseline.data.epoch === 'string';
      if (supportsEpoch) {
        assert.match(baseline.data.epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      }
      const result = await expectStatus('/api/sync/v2', 200, {
        user: alice,
        json: {
          cursor: supportsEpoch ? baseline.data.cursor : 999_999_999,
          ...(supportsEpoch ? { epoch: '00000000-0000-4000-8000-000000000001' } : {}),
          changes: [],
        },
      });
      assert.equal(result.data.reset, true);
      if (supportsEpoch) assert.equal(result.data.epoch, baseline.data.epoch);
      else assert.ok(result.data.cursor < 999_999_999);
      assert.ok(result.data.changes.length > 0);
    });

    test('legacy sync LWW rejects an older manuscript write', async () => {
      const t = Date.now() + 10_000;
      await expectStatus('/api/sync', 200, {
        user: bob,
        json: {
          since: 0,
          push: {
            manuscripts: [{ id: 'formal_v1', data: JSON.stringify({ id: 'formal_v1', title: 'newer' }), last_modified: t }],
            chapters: [],
            plugins: [],
          },
        },
      });
      const result = await expectStatus('/api/sync', 200, {
        user: bob,
        json: {
          since: 0,
          push: {
            manuscripts: [{ id: 'formal_v1', data: JSON.stringify({ id: 'formal_v1', title: 'older' }), last_modified: t - 1 }],
            chapters: [],
            plugins: [],
          },
        },
      });
      const record = result.data.pull.manuscripts.find((item) => item.id === 'formal_v1');
      assert.equal(JSON.parse(record.data).title, 'newer');
    });

    test('legacy sync tombstone rejects even a future-clock resurrection', async () => {
      const t = Date.now() + 20_000;
      await expectStatus('/api/sync', 200, {
        user: bob,
        json: {
          since: 0,
          push: {
            manuscripts: [{ id: 'formal_v1', data: JSON.stringify({ id: 'formal_v1' }), last_modified: t, deleted: true }],
            chapters: [],
            plugins: [],
          },
        },
      });
      const result = await expectStatus('/api/sync', 200, {
        user: bob,
        json: {
          since: 0,
          push: {
            manuscripts: [{ id: 'formal_v1', data: JSON.stringify({ id: 'formal_v1', title: 'resurrected' }), last_modified: t + 9_000_000 }],
            chapters: [],
            plugins: [],
          },
        },
      });
      const record = result.data.pull.manuscripts.find((item) => item.id === 'formal_v1');
      assert.equal(record.deleted, true);
      assert.deepEqual(JSON.parse(record.data), { id: 'formal_v1' });
    });

    test('sync v2 paginates over 1,000 change-log rows without an unbounded page', async () => {
      const changes = Array.from({ length: 1001 }, (_, index) => ({
        entity: 'profile',
        operation: 'upsert',
        baseRevision: index,
        data: JSON.stringify({ sequence: index + 1 }),
      }));
      const first = await expectStatus('/api/sync/v2', 200, {
        user: 'pager',
        json: { cursor: 0, changes },
      });
      assert.equal(first.data.results.length, 1001);
      assert.equal(first.data.results.every((result) => result.status === 'accepted'), true);
      assert.equal(first.data.hasMore, true);
      assert.ok(first.data.changes.length <= 1000);
      const second = await expectStatus('/api/sync/v2', 200, {
        user: 'pager',
        json: { cursor: first.data.cursor, changes: [] },
      });
      assert.equal(second.data.hasMore, false);
      assert.ok(second.data.cursor > first.data.cursor);
      assert.equal(JSON.parse(second.data.changes.at(-1).data).sequence, 1001);
    });

    test('settings enforce a string map and round-trip Unicode values', async () => {
      const settings = { theme: 'dark', font: 'Noto Serif 日本語', checker: '✓' };
      await expectStatus('/api/settings', 200, { user: alice, method: 'PUT', json: { settings } });
      const result = await expectStatus('/api/settings', 200, { user: alice });
      assert.deepEqual(result.data.settings, settings);
      const invalid = await expectStatus('/api/settings', 400, {
        user: alice,
        method: 'PUT',
        json: { settings: { bad: 42 } },
      });
      assert.match(invalid.data.error, /must be a string/);
    });

    test('settings size limit rejects an oversized payload', async () => {
      const result = await expectStatus('/api/settings', 413, {
        user: alice,
        method: 'PUT',
        json: { settings: { tooLarge: 'x'.repeat(129 * 1024) } },
      });
      assert.match(result.data.error, /too large/i);
    });

    test('settings are private per authenticated user', async () => {
      const result = await expectStatus('/api/settings', 200, { user: bob });
      assert.equal(result.data.settings, null);
    });

    test('durability fixture manuscript is created for cover and collaboration tests', async () => {
      const result = await expectStatus('/api/manuscripts', 201, {
        user: alice,
        json: manuscript('formal_durable', 'Durable Book', [
          { id: 'collab', title: 'Collaborative', content: '<p>Initial collaborative prose</p>' },
        ]),
      });
      durable = result.data;
      collabDocumentName = `${encodeURIComponent(aliceId)}/formal_durable:collab`;
      assert.equal(durable.chapters[0].revision, 1);
    });

    test('cover upload sniffs PNG magic instead of trusting Content-Type', async () => {
      const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
      const result = await expectStatus('/api/covers/formal_durable', 200, {
        user: alice,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: png,
      });
      coverName = result.data.coverArt;
      assert.equal(result.data.mime, 'image/png');
      assert.equal(result.data.bytes, png.length);
    });

    test('cover GET is exact, private-cache scoped, and user isolated', async () => {
      const result = await expectStatus(`/api/covers/${coverName}`, 200, { user: alice });
      assert.equal(result.bytes.toString('hex'), '89504e470d0a1a0a0000000049454e44ae426082');
      assert.equal(result.headers.get('content-type'), 'image/png');
      assert.match(result.headers.get('cache-control') || '', /^private/);
      await expectStatus(`/api/covers/${coverName}`, 404, { user: bob });
    });

    test('cover upload rejects bytes with unsupported magic', async () => {
      const result = await expectStatus('/api/covers/formal_durable', 415, {
        user: alice,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('not an image'),
      });
      assert.match(result.data.error, /unsupported/i);
    });

    test('cover upload enforces the 8 MiB request limit', async () => {
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0);
      oversized.set(Buffer.from('89504e470d0a1a0a', 'hex'));
      const result = await expectStatus('/api/covers/formal_durable', 413, {
        user: alice,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: oversized,
      });
      assert.match(result.data.error, /too large/i);
    });

    test('collaboration rejects a missing forward identity', async () => {
      assert.equal(await expectDenied({
        user: alice,
        documentName: collabDocumentName,
        includeHeaders: false,
      }), true);
    });

    test('collaboration rejects a document scoped to another verified user', async () => {
      assert.equal(await expectDenied({
        user: alice,
        documentName: `${encodeURIComponent(bobId)}/formal_durable:collab`,
      }), true);
    });

    test('two collaboration clients converge and persist a Yjs update', async () => {
      const left = await connectDocument({ user: alice, documentName: collabDocumentName });
      const right = await connectDocument({ user: alice, documentName: collabDocumentName });
      try {
        await convergeMap(left, right, 'durability-proof', 'converged-東京-✓');
        assert.equal(right.document.getMap('formal').get('durability-proof'), 'converged-東京-✓');
      } finally {
        closeConnection(left);
        closeConnection(right);
      }
      const reopened = await connectDocument({ user: alice, documentName: collabDocumentName });
      try {
        await eventually(() => reopened.document.getMap('formal').get('durability-proof') === 'converged-東京-✓', {
          timeoutMs: 10_000,
          label: 'persisted collaborative state',
        });
      } finally {
        closeConnection(reopened);
      }
    });

    test('portable S3 metadata and chapter keys carry checksum and generation metadata', async () => {
      const metadataKey = portable(aliceId, 'manuscripts/formal_durable/metadata.json');
      const chapterKey = portable(aliceId, 'manuscripts/formal_durable/chapters/collab.html');
      const [metadata, chapter] = await Promise.all([waitObject(metadataKey), waitObject(chapterKey)]);
      assert.equal(metadata.contentType, 'application/json');
      assert.match(chapter.contentType || '', /^text\/html/);
      assertChronicleMetadata(assert, metadata);
      assertChronicleMetadata(assert, chapter);
      const parsed = JSON.parse(metadata.bytes.toString('utf8'));
      assert.equal(parsed.kind, 'manuscript');
      assert.equal(parsed.userId, aliceId);
      assert.equal(parsed.id, 'formal_durable');
      const envelope = parseChapterEnvelope(chapter.bytes);
      assert.equal(envelope.metadata.kind, 'chapter');
      assert.equal(envelope.metadata.id, 'collab');
      assert.match(envelope.text, /Initial collaborative prose/);
    });

    test('portable S3 settings and cover keys preserve bytes and content types', async () => {
      const settingsKey = portable(aliceId, 'settings.json');
      const coverKey = portable(aliceId, `covers/${coverName}`);
      const [settings, cover] = await Promise.all([waitObject(settingsKey), waitObject(coverKey)]);
      assert.equal(settings.contentType, 'application/json');
      assert.equal(cover.contentType, 'image/png');
      assert.deepEqual(JSON.parse(settings.bytes.toString('utf8')), {
        theme: 'dark', font: 'Noto Serif 日本語', checker: '✓',
      });
      assert.equal(cover.bytes.toString('hex'), '89504e470d0a1a0a0000000049454e44ae426082');
      assertChronicleMetadata(assert, settings);
      assertChronicleMetadata(assert, cover);
    });

    test('remote manuscript tombstone is scrubbed of metadata and deleted prose', async () => {
      const key = portable(aliceId, 'manuscripts/formal_unicode/metadata.json');
      const object = await waitObject(key, (candidate) => {
        try { return JSON.parse(candidate.bytes.toString('utf8')).kind === 'manuscript-tombstone'; } catch { return false; }
      });
      const record = JSON.parse(object.bytes.toString('utf8'));
      assert.equal(record.kind, 'manuscript-tombstone');
      assert.equal(Object.hasOwn(record, 'metadata'), false);
      assert.equal(Object.hasOwn(record, 'lastModified'), false);
      assert.equal(object.bytes.includes(Buffer.from('secret prose')), false);
      assertChronicleMetadata(assert, object);
    });

    test('remote chapter tombstones contain no title or prose bytes', async () => {
      for (const chapterId of ['alpha', 'beta']) {
        const key = portable(aliceId, `manuscripts/formal_unicode/chapters/${chapterId}.html`);
        const object = await waitObject(key, (candidate) => {
          try { return parseChapterEnvelope(candidate.bytes).metadata.kind === 'chapter-tombstone'; } catch { return false; }
        });
        const envelope = parseChapterEnvelope(object.bytes);
        assert.equal(envelope.metadata.kind, 'chapter-tombstone');
        assert.equal(envelope.metadata.contentBytes, 0);
        assert.equal(Object.hasOwn(envelope.metadata, 'title'), false);
        assert.equal(envelope.text.includes('Fresh revision'), false);
        assert.equal(envelope.text.includes('Здравствуй'), false);
      }
    });

    test('deleting a manuscript removes its opaque cover object from S3', async () => {
      const created = await expectStatus('/api/manuscripts', 201, {
        user: alice,
        json: manuscript('formal_cover_delete', 'Disposable cover', []),
      });
      const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
      const uploaded = await expectStatus('/api/covers/formal_cover_delete', 200, {
        user: alice,
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: png,
      });
      const key = portable(aliceId, `covers/${uploaded.data.coverArt}`);
      await waitObject(key);
      const latest = (await request('/api/manuscripts/formal_cover_delete', { user: alice })).data;
      await expectStatus('/api/manuscripts/formal_cover_delete', 204, {
        user: alice,
        method: 'DELETE',
        json: { baseRevision: latest.metadata.revision },
      });
      await waitObjectAbsent(key);
      assert.equal(await headObject(key), null);
      assert.ok(created.data.metadata.revision >= 1);
    });

    test('all current S3 objects stay beneath the configured portable prefix', async () => {
      const objects = await listObjects();
      assert.ok(objects.length >= 8);
      assert.equal(objects.every((item) => item.Key.startsWith('formal/v1/users/')), true);
      assert.equal(objects.some((item) => item.logicalKey.includes('manuscript.json')), false);
    });

    test('replication drains to healthy readiness after the foundation workload', async () => {
      const ready = await waitReady(
        (body) => body.replica?.state === 'healthy' && body.replica.pending === 0 && body.replica.deadLetters === 0,
        'healthy drained S3 replica',
      );
      assert.equal(ready.replica.initialized, true);
    });

    test('remote object checksum can be independently recomputed', async () => {
      const key = portable(aliceId, 'manuscripts/formal_durable/metadata.json');
      const object = await getObject(key);
      const digest = crypto.createHash('sha256').update(object.bytes).digest('hex');
      assert.equal(digest, object.metadata['chronicle-checksum']);
    });
  });
}
