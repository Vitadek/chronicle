import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-concurrency-'));
process.env.DATA_DIR = dataDir;
process.env.AUTH_MODE = 'none';

const { db } = await import('../server/db');
const {
  deleteChapter,
  deleteManuscript,
  loadManuscript,
  saveLegacyManuscript,
  touchManuscriptForChapterChange,
} = await import('../server/lib/manuscriptRepository');
const { parsePortableChapter, portableChapterKey, portableManuscriptKey } = await import(
  '../server/lib/portableReplica'
);
const { persistCollaborativeStateIfLive } = await import(
  '../server/lib/collabPersistence'
);

const userId = 'local';
const initial = {
  metadata: {
    id: 'book',
    title: 'Book',
    author: 'Author',
    lastModified: 1,
  },
  chapters: [
    { id: 'one', title: 'One', content: '<p>one</p>', lastModified: 1 },
    { id: 'two', title: 'Two', content: '<p>two</p>', lastModified: 1 },
  ],
};

try {
  const created = saveLegacyManuscript(userId, initial, { createOnly: true });
  assert.equal(created.conflicts.length, 0);

  // A duplicate create must be side-effect free. Previously the metadata
  // conflict was reported while the same POST could still update children.
  const duplicateCreate = structuredClone(loadManuscript(userId, 'book')!);
  duplicateCreate.chapters[0].content = '<p>injected through duplicate POST</p>';
  duplicateCreate.chapters[0].lastModified += 10_000;
  const duplicateResult = saveLegacyManuscript(userId, duplicateCreate, { createOnly: true });
  assert(duplicateResult.conflicts.some((conflict) => conflict.reason === 'already-exists'));
  assert.equal(loadManuscript(userId, 'book')!.chapters[0].content, '<p>one</p>');

  const deviceA = structuredClone(loadManuscript(userId, 'book')!);
  const deviceB = structuredClone(loadManuscript(userId, 'book')!);

  deviceA.metadata.title = 'Edited on A';
  deviceA.metadata.lastModified += 1;
  deviceA.chapters[0].content = '<p>one from A</p>';
  deviceA.chapters[0].lastModified += 1;
  const savedA = saveLegacyManuscript(userId, deviceA);
  assert.equal(savedA.conflicts.length, 0);

  // B has stale metadata and chapter one, but a valid independent edit to
  // chapter two. The metadata conflict must not discard B's chapter-two edit,
  // and B's stale chapter one must never overwrite A.
  deviceB.metadata.title = 'Edited on B';
  deviceB.metadata.lastModified += 1;
  deviceB.chapters[1].content = '<p>two from B</p>';
  deviceB.chapters[1].lastModified += 2;
  const savedB = saveLegacyManuscript(userId, deviceB);
  const metadataConflict = savedB.conflicts.find(
    (conflict) => conflict.entity === 'manuscript',
  );
  assert(metadataConflict);
  assert.equal(
    metadataConflict.currentRevision,
    savedB.manuscript?.metadata.revision,
    'metadata conflict token was captured before a child mutation advanced the parent',
  );
  const sameChapterConflict = savedB.conflicts.find(
    (conflict) => conflict.entity === 'chapter' && conflict.id === 'one',
  );
  assert(sameChapterConflict, 'the stale same-chapter edit must return a typed conflict');
  assert.equal(sameChapterConflict.reason, 'stale-revision');
  assert.equal(sameChapterConflict.expectedRevision, deviceB.chapters[0].revision);
  assert.equal(savedB.manuscript?.chapters[0].content, '<p>one from A</p>');

  const merged = loadManuscript(userId, 'book')!;
  assert.equal(merged.metadata.title, 'Edited on A');
  assert.equal(merged.chapters[0].content, '<p>one from A</p>');
  assert.equal(merged.chapters[1].content, '<p>two from B</p>');

  // A stale full-document save that omits a chapter is not a delete.
  const missingChapter = structuredClone(merged);
  missingChapter.chapters = [missingChapter.chapters[0]];
  saveLegacyManuscript(userId, missingChapter);
  assert.equal(loadManuscript(userId, 'book')!.chapters.length, 2);

  // A child-only writer must advance the aggregate manuscript token so an
  // unseen chapter edit blocks a stale whole-book DELETE.
  const beforeChildOnlyEdit = structuredClone(loadManuscript(userId, 'book')!);
  const childOnlyEdit = structuredClone(beforeChildOnlyEdit);
  childOnlyEdit.chapters[0].content = '<p>aggregate revision guard</p>';
  childOnlyEdit.chapters[0].lastModified += 1;
  const childOnlyResult = saveLegacyManuscript(userId, childOnlyEdit);
  assert.equal(childOnlyResult.conflicts.length, 0);
  const afterChildOnlyEdit = loadManuscript(userId, 'book')!;
  assert(
    afterChildOnlyEdit.metadata.revision! > beforeChildOnlyEdit.metadata.revision!,
    'child edit did not advance aggregate manuscript revision',
  );
  const unseenChildDelete = deleteManuscript(
    userId,
    'book',
    beforeChildOnlyEdit.metadata.revision,
  );
  assert(unseenChildDelete && unseenChildDelete.ok === false);

  // An older child clock may advance the aggregate revision, but it must not
  // move either representation of the parent timestamp backward.
  const beforeSlowClockTouch = loadManuscript(userId, 'book')!;
  const slowClockRevision = touchManuscriptForChapterChange(
    userId,
    'book',
    beforeSlowClockTouch.metadata.lastModified - 1,
  );
  const afterSlowClockTouch = loadManuscript(userId, 'book')!;
  assert.equal(afterSlowClockTouch.metadata.lastModified, beforeSlowClockTouch.metadata.lastModified);
  assert.equal(slowClockRevision, beforeSlowClockTouch.metadata.revision! + 1);
  const storedParent = db.prepare(`
    SELECT data, last_modified FROM manuscripts WHERE user_id = ? AND id = 'book'
  `).get(userId) as { data: string; last_modified: number };
  assert.equal(storedParent.last_modified, beforeSlowClockTouch.metadata.lastModified);
  assert.equal(
    (JSON.parse(storedParent.data) as { lastModified: number }).lastModified,
    beforeSlowClockTouch.metadata.lastModified,
  );

  const wrongDelete = deleteChapter(
    userId,
    'book',
    'two',
    merged.chapters[1].revision! - 1,
  );
  assert(wrongDelete && wrongDelete.ok === false);
  assert.equal(loadManuscript(userId, 'book')!.chapters.length, 2);

  db.prepare('INSERT INTO ydocs(name, data, updated_at) VALUES (?, ?, ?)').run(
    'local/book:two',
    Buffer.from('deleted chapter ydoc secret'),
    Date.now(),
  );
  db.prepare('INSERT INTO ydocs(name, data, updated_at) VALUES (?, ?, ?)').run(
    'book:two',
    Buffer.from('deleted legacy ydoc secret'),
    Date.now(),
  );
  db.prepare(`
    INSERT INTO chapter_pre_collab(
      user_id, manuscript_id, chapter_id, content, backed_up_at
    ) VALUES (?, 'book', 'two', '<p>deleted pre-collab secret</p>', ?)
  `).run(userId, Date.now());

  const acceptedDelete = deleteChapter(
    userId,
    'book',
    'two',
    loadManuscript(userId, 'book')!.chapters[1].revision,
  );
  assert(acceptedDelete && acceptedDelete.ok === true);
  assert.equal(loadManuscript(userId, 'book')!.chapters.length, 1);
  const scrubbedChapter = db.prepare(`
    SELECT title, content, position, deleted_at FROM chapters
    WHERE user_id = ? AND manuscript_id = 'book' AND id = 'two'
  `).get(userId) as {
    title: string | null;
    content: string | null;
    position: number | null;
    deleted_at: number | null;
  };
  assert.notEqual(scrubbedChapter.deleted_at, null);
  assert.equal(scrubbedChapter.title, null);
  assert.equal(scrubbedChapter.content, null);
  assert.equal(scrubbedChapter.position, null);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM ydocs WHERE name IN ('local/book:two', 'book:two')
    `).get() as { count: number }).count,
    0,
  );
  assert.equal(
    persistCollaborativeStateIfLive(
      'local/book:two',
      Buffer.from('late deleted chapter collaborative secret'),
      userId,
      'book',
      'two',
    ),
    false,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM ydocs WHERE name = 'local/book:two'`).get() as {
      count: number;
    }).count,
    0,
    'late collaboration store recreated a deleted chapter Y.Doc',
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM chapter_pre_collab
      WHERE user_id = ? AND manuscript_id = 'book' AND chapter_id = 'two'
    `).get(userId) as { count: number }).count,
    0,
  );
  const chapterReplica = db.prepare(`
    SELECT payload FROM storage_replica_manifest WHERE key = ?
  `).get(portableChapterKey(userId, 'book', 'two')) as { payload: Buffer };
  assert.equal(
    parsePortableChapter(Buffer.from(chapterReplica.payload)).metadata.kind,
    'chapter-tombstone',
  );
  assert(!chapterReplica.payload.includes(Buffer.from('two from B')));
  const repeatedChapterDelete = deleteChapter(userId, 'book', 'two', merged.chapters[1].revision);
  assert(repeatedChapterDelete && repeatedChapterDelete.ok === true);

  const beforeManuscriptDelete = loadManuscript(userId, 'book')!;
  const staleManuscriptDelete = deleteManuscript(
    userId,
    'book',
    beforeManuscriptDelete.metadata.revision! - 1,
  );
  assert(staleManuscriptDelete && staleManuscriptDelete.ok === false);
  assert.ok(loadManuscript(userId, 'book'));

  db.prepare('INSERT INTO ydocs(name, data, updated_at) VALUES (?, ?, ?)').run(
    'local/book:one',
    Buffer.from('deleted book ydoc secret'),
    Date.now(),
  );
  db.prepare(`
    INSERT INTO chapter_pre_collab(
      user_id, manuscript_id, chapter_id, content, backed_up_at
    ) VALUES (?, 'book', 'one', '<p>deleted book backup secret</p>', ?)
  `).run(userId, Date.now());

  const acceptedManuscriptDelete = deleteManuscript(
    userId,
    'book',
    beforeManuscriptDelete.metadata.revision,
  );
  assert(acceptedManuscriptDelete && acceptedManuscriptDelete.ok === true);
  assert.equal(loadManuscript(userId, 'book'), null);
  const scrubbedBook = db.prepare(`
    SELECT data, deleted_at FROM manuscripts WHERE user_id = ? AND id = 'book'
  `).get(userId) as { data: string; deleted_at: number | null };
  assert.notEqual(scrubbedBook.deleted_at, null);
  assert.deepEqual(JSON.parse(scrubbedBook.data), { id: 'book' });
  const scrubbedChildren = db.prepare(`
    SELECT title, content, position FROM chapters
    WHERE user_id = ? AND manuscript_id = 'book'
  `).all(userId) as Array<{
    title: string | null;
    content: string | null;
    position: number | null;
  }>;
  assert(scrubbedChildren.every((row) =>
    row.title === null && row.content === null && row.position === null
  ));
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM ydocs
      WHERE name IN ('local/book:one', 'book:one')
    `).get() as { count: number }).count,
    0,
  );
  assert.equal(
    persistCollaborativeStateIfLive(
      'local/book:one',
      Buffer.from('late deleted manuscript collaborative secret'),
      userId,
      'book',
      'one',
    ),
    false,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM ydocs WHERE name = 'local/book:one'`).get() as {
      count: number;
    }).count,
    0,
    'late collaboration store recreated a Y.Doc beneath a parent tombstone',
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM chapter_pre_collab
      WHERE user_id = ? AND manuscript_id = 'book'
    `).get(userId) as { count: number }).count,
    0,
  );
  const manuscriptReplica = db.prepare(`
    SELECT payload FROM storage_replica_manifest WHERE key = ?
  `).get(portableManuscriptKey(userId, 'book')) as { payload: Buffer };
  const replicaTombstone = JSON.parse(manuscriptReplica.payload.toString('utf8')) as {
    kind: string;
    metadata?: unknown;
  };
  assert.equal(replicaTombstone.kind, 'manuscript-tombstone');
  assert.equal(replicaTombstone.metadata, undefined);
  assert(!manuscriptReplica.payload.includes(Buffer.from('Edited on A')));
  const repeatedManuscriptDelete = deleteManuscript(
    userId,
    'book',
    beforeManuscriptDelete.metadata.revision,
  );
  assert(repeatedManuscriptDelete && repeatedManuscriptDelete.ok === true);

  const orphanAttempt = structuredClone(beforeManuscriptDelete);
  orphanAttempt.chapters.push({
    id: 'orphan-after-delete',
    title: 'Must not exist',
    content: '<p>orphan</p>',
    lastModified: Date.now(),
  });
  const orphanResult = saveLegacyManuscript(userId, orphanAttempt);
  assert(orphanResult.conflicts.some((conflict) => conflict.reason === 'deleted'));
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM chapters
      WHERE user_id = ? AND manuscript_id = 'book' AND id = 'orphan-after-delete'
    `).get(userId) as { count: number }).count,
    0,
  );

  const changeCount = (
    db.prepare('SELECT COUNT(*) AS count FROM change_log WHERE user_id = ?').get(userId) as {
      count: number;
    }
  ).count;
  assert(changeCount >= 6, 'accepted record mutations must advance the server change log');

  console.log('PASS manuscript concurrency, stale-save, and deletion guards');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
