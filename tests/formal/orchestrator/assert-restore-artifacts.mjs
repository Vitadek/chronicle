import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const action = process.argv[2];
const artifactDir = process.env.REPORT_DIR || '/artifacts';

async function readJson(name) {
  return JSON.parse(await fs.readFile(path.join(artifactDir, name), 'utf8'));
}

function summary(value) {
  return {
    manuscripts: value.manuscripts,
    chapters: value.chapters,
    profiles: value.profiles,
    blobs: value.blobs,
    ignored: value.ignored,
    conflicts: value.conflicts,
  };
}

function assertSummary(actual, expected) {
  assert.deepEqual(summary(actual), summary(expected));
}

const baseline = await readJson('restore-baseline.json');

if (action === 'dry-runs') {
  const all = await readJson('restore-dry-run-all.json');
  const alice = await readJson('restore-dry-run-user.json');
  assert.equal(all.dryRun, true);
  assert.equal(all.user, 'all');
  assertSummary(all, baseline.restore.all);
  assert.deepEqual([...all.conflictKeys].sort(), baseline.restore.all.conflictKeys);
  assert.equal(new Set(all.conflictKeys).size, all.conflicts);
  assert.equal(alice.dryRun, true);
  assert.equal(alice.user, baseline.aliceId);
  assertSummary(alice, baseline.restore.alice);
  assert.deepEqual([...alice.conflictKeys].sort(), baseline.restore.alice.conflictKeys);
  assert.equal(new Set(alice.conflictKeys).size, alice.conflicts);
  console.log('Restore dry-run artifacts match the exact real-MinIO inventory.');
} else if (action === 'apply') {
  const applied = await readJson('restore-apply-force.json');
  assert.equal(applied.dryRun, false);
  assert.equal(applied.user, 'all');
  assertSummary(applied, baseline.restore.all);
  assert.match(applied.backupPath, /^\/data\/chronicle-before-restore-[A-Za-z0-9-]+\.db$/);
  assert.equal(applied.cascadedChapters, 0);
  assert.equal(applied.skippedCovers, 0);
  assert.deepEqual(applied.databaseManifest, { checked: 16, enqueued: 16 });
  assert.deepEqual(applied.target, { changed: false, seeded: 0 });
  console.log('Forced restore artifact records the expected offline apply and backup.');
} else if (action === 'backup') {
  const backup = await readJson('automatic-backup-verification.json');
  assert.equal(backup.integrity, 'ok');
  assert.equal(backup.epoch, baseline.v2.epoch);
  assert.deepEqual(backup.authoritativeRevisions, baseline.preApply.authoritativeRevisions);
  assert.deepEqual(backup.settings, baseline.preApply.settings);
  assert.equal(backup.durable.title, baseline.preApply.durable.title);
  assert.equal(backup.durable.manuscriptRevision, baseline.preApply.durable.manuscriptRevision);
  assert.equal(backup.durable.chapterContent, baseline.preApply.durable.chapterContent);
  assert.equal(backup.durable.chapterRevision, baseline.preApply.durable.chapterRevision);
  assert.equal(backup.deleted.manuscriptData, JSON.stringify({ id: baseline.records.deleted.manuscriptId }));
  assert.equal(backup.deleted.chapterTitle, null);
  assert.equal(backup.deleted.chapterContent, null);
  assert.equal(backup.deleted.chapterPosition, null);
  assert.equal(backup.deleted.collaborationRows, 0);
  assert.equal(backup.deleted.preCollaborationRows, 0);
  assert.deepEqual(backup.profile, baseline.preApply.profile);
  assert.ok(backup.outage.manuscriptDeletedAt > 0);
  assert.ok(backup.outage.chapterDeletedAt > 0);
  assert.equal(backup.outage.manuscriptData, JSON.stringify({ id: 'formal_outage' }));
  assert.equal(backup.outage.chapterTitle, null);
  assert.equal(backup.outage.chapterContent, null);
  assert.equal(backup.outage.chapterPosition, null);
  assert.equal(backup.outage.manuscriptRevision, baseline.preApply.outage.manuscriptRevision);
  assert.equal(backup.outage.chapterRevision, baseline.preApply.outage.chapterRevision);
  assert.deepEqual(backup.blobs.map((item) => item.key), [`settings/${baseline.aliceId}`]);
  assert.equal(backup.outbox.length, baseline.preApply.deadLetters);
  assert.equal(backup.outbox.every((item) => item.deadLetter === 1), true);
  assert.deepEqual(backup.outbox.map((item) => item.key), [
    `v1/users/${encodeURIComponent(baseline.aliceId)}/covers/${baseline.cover.filename}`,
    `v1/users/${encodeURIComponent(baseline.aliceId)}/manuscripts/formal_durable/chapters/collab.html`,
    `v1/users/${encodeURIComponent(baseline.aliceId)}/manuscripts/formal_durable/metadata.json`,
    `v1/users/${encodeURIComponent(baseline.aliceId)}/manuscripts/formal_outage/chapters/offline.html`,
    `v1/users/${encodeURIComponent(baseline.aliceId)}/manuscripts/formal_outage/metadata.json`,
    `v1/users/${encodeURIComponent(baseline.aliceId)}/profile.json`,
    `v1/users/${encodeURIComponent(baseline.aliceId)}/settings.json`,
  ].sort());
  assert.deepEqual(backup.counts, {
    users: 4,
    manuscripts: 7,
    chapters: 7,
    profiles: 2,
    storageBlobs: 1,
    replicaManifest: 19,
    replicaOutbox: 7,
  });
  console.log('Automatic pre-restore backup is integral and matches every captured token.');
} else if (action === 'verify') {
  const verification = await readJson('verify-after-offline-restore.json');
  assert.equal(verification.checked, 19);
  assert.equal(verification.matched, 19);
  assert.deepEqual(verification.missing, []);
  assert.deepEqual(verification.unexpected, []);
  assert.deepEqual(verification.mismatched, []);
  assert.deepEqual(verification.unverifiable, []);
  console.log('Post-restore deep verification matched all 19 desired replica keys.');
} else {
  throw new Error(`Unknown restore artifact assertion: ${action}`);
}
