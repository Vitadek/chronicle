import fs from 'fs';
import path from 'path';
import { config, validateConfig } from './config';
import { db } from './db';
import {
  PORTABLE_REPLICA_ROOT,
  parsePortableChapter,
  reconcileReplicaTarget,
  seedPortableDatabaseManifest,
  type PortableManuscriptRecord,
  type PortableProfileRecord,
} from './lib/portableReplica';
import {
  applyRestorePlan,
  partitionRestoreBlobsForTombstones,
} from './lib/restoreApply';
import { storage } from './lib/storage/HybridManager';

type Flags = Map<string, string | true>;

interface RestoreManuscript {
  key: string;
  record: PortableManuscriptRecord;
}

interface RestoreChapter {
  key: string;
  record: ReturnType<typeof parsePortableChapter>;
}

interface RestoreProfile {
  key: string;
  record: PortableProfileRecord;
}

interface RestoreBlob {
  remoteKey: string;
  localKey: string;
  userId: string;
  contentType: string;
  size?: number;
  content?: Buffer;
}

interface RestorePlan {
  manuscripts: RestoreManuscript[];
  chapters: RestoreChapter[];
  profiles: RestoreProfile[];
  blobs: RestoreBlob[];
  ignored: string[];
}

function usage(): string {
  return `Chronicle storage administration

Usage:
  npm run storage -- status
  npm run storage -- verify [--prefix <replica-prefix>]
  npm run storage -- retry [--key <replica-key>]
  npm run storage -- seed
  npm run storage -- backup [--output <path>]
  npm run storage -- restore [--user <id>] [--apply] [--force]

restore is a dry run unless --apply is present. Applying creates a hot SQLite
backup first and refuses to overwrite existing records unless --force is set.`;
}

function parseArguments(argv: string[]): { command: string; flags: Flags } {
  const [command = 'help', ...rest] = argv;
  const flags: Flags = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [rawName, inline] = token.slice(2).split('=', 2);
    if (!rawName) throw new Error(`Invalid option: ${token}`);
    if (inline !== undefined) {
      flags.set(rawName, inline);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(rawName, next);
      index += 1;
    } else {
      flags.set(rawName, true);
    }
  }
  return { command, flags };
}

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value.`);
  return value;
}

function assertOnlyFlags(flags: Flags, allowed: string[]): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw new Error(`Unknown option: --${name}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
}

function decodeSegment(value: string, key: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Replica object has an invalid encoded path segment: ${key}`);
  }
}

function validateManuscript(value: unknown, key: string): PortableManuscriptRecord {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.userId !== 'string' ||
    typeof value.id !== 'string' ||
    !positiveInteger(value.revision)
  ) {
    throw new Error(`Portable manuscript has an invalid shape: ${key}`);
  }
  if (value.kind === 'manuscript') {
    if (!nonnegativeInteger(value.lastModified) || !isObject(value.metadata)) {
      throw new Error(`Portable manuscript has an invalid shape: ${key}`);
    }
  } else if (value.kind === 'manuscript-tombstone') {
    if (
      !nonnegativeInteger(value.deletedAt) ||
      Object.hasOwn(value, 'metadata') ||
      Object.hasOwn(value, 'lastModified')
    ) {
      throw new Error(`Portable manuscript tombstone has an invalid shape: ${key}`);
    }
  } else {
    throw new Error(`Portable manuscript has an unsupported kind: ${key}`);
  }
  return value as unknown as PortableManuscriptRecord;
}

function validateProfile(value: unknown, key: string): PortableProfileRecord {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'profile' ||
    typeof value.userId !== 'string' ||
    !positiveInteger(value.revision) ||
    !nonnegativeInteger(value.lastModified)
  ) {
    throw new Error(`Portable profile has an invalid shape: ${key}`);
  }
  return value as unknown as PortableProfileRecord;
}

function contentTypeForCover(filename: string): string {
  const extension = filename.split('.').at(-1)?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  throw new Error(`Unsupported cover extension in replica: ${filename}`);
}

function validCoverBytes(bytes: Buffer, contentType: string): boolean {
  if (contentType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

async function fetchReplica(key: string): Promise<Buffer> {
  const value = await storage.getReplica(key);
  if (!value) throw new Error(`Replica object disappeared while reading: ${key}`);
  return value;
}

async function buildRestorePlan(userFilter?: string): Promise<RestorePlan> {
  const objects = await storage.listReplica(`${PORTABLE_REPLICA_ROOT}/`);
  const plan: RestorePlan = {
    manuscripts: [],
    chapters: [],
    profiles: [],
    blobs: [],
    ignored: [],
  };
  const seen = new Set<string>();

  for (const object of objects) {
    const key = object.key;
    if (seen.has(key)) throw new Error(`Replica returned duplicate key: ${key}`);
    seen.add(key);

    let match = /^v1\/users\/([^/]+)\/manuscripts\/([^/]+)\/metadata\.json$/.exec(key);
    if (match) {
      const pathUser = decodeSegment(match[1], key);
      const pathId = decodeSegment(match[2], key);
      if (userFilter && pathUser !== userFilter) continue;
      const bytes = await fetchReplica(key);
      if (bytes.length > 100_000) throw new Error(`Manuscript metadata is too large: ${key}`);
      const record = validateManuscript(parseJson(bytes, key), key);
      if (record.userId !== pathUser || record.id !== pathId) {
        throw new Error(`Manuscript path and payload identity disagree: ${key}`);
      }
      plan.manuscripts.push({ key, record });
      continue;
    }

    match = /^v1\/users\/([^/]+)\/manuscripts\/([^/]+)\/chapters\/([^/]+)\.html$/.exec(key);
    if (match) {
      const pathUser = decodeSegment(match[1], key);
      const pathManuscript = decodeSegment(match[2], key);
      const pathChapter = decodeSegment(match[3], key);
      if (userFilter && pathUser !== userFilter) continue;
      const bytes = await fetchReplica(key);
      if (bytes.length > 5_100_000) throw new Error(`Chapter object is too large: ${key}`);
      const record = parsePortableChapter(bytes);
      const metadata = record.metadata;
      const identityInvalid =
        metadata.userId !== pathUser ||
        metadata.manuscriptId !== pathManuscript ||
        metadata.id !== pathChapter;
      const liveInvalid = metadata.kind === 'chapter' && (
        metadata.title.length > 500 ||
        Buffer.byteLength(record.content, 'utf8') > 5_000_000
      );
      const tombstoneInvalid = metadata.kind === 'chapter-tombstone' && record.content !== '';
      if (identityInvalid || liveInvalid || tombstoneInvalid) {
        throw new Error(`Chapter path and payload metadata disagree: ${key}`);
      }
      plan.chapters.push({ key, record });
      continue;
    }

    match = /^v1\/users\/([^/]+)\/profile\.json$/.exec(key);
    if (match) {
      const pathUser = decodeSegment(match[1], key);
      if (userFilter && pathUser !== userFilter) continue;
      const bytes = await fetchReplica(key);
      if (bytes.length > 100_000) throw new Error(`Profile object is too large: ${key}`);
      const record = validateProfile(parseJson(bytes, key), key);
      if (record.userId !== pathUser) {
        throw new Error(`Profile path and payload identity disagree: ${key}`);
      }
      plan.profiles.push({ key, record });
      continue;
    }

    match = /^v1\/users\/([^/]+)\/covers\/([^/]+)$/.exec(key);
    if (match) {
      const userId = decodeSegment(match[1], key);
      if (userFilter && userId !== userFilter) continue;
      if ((object.size ?? 0) > 8 * 1024 * 1024) throw new Error(`Cover is too large: ${key}`);
      const filename = decodeSegment(match[2], key);
      if (!/^[A-Za-z0-9_.-]+$/.test(filename)) throw new Error(`Invalid cover filename: ${key}`);
      plan.blobs.push({
        remoteKey: key,
        localKey: `covers/${userId}/${filename}`,
        userId,
        contentType: contentTypeForCover(filename),
        size: object.size,
      });
      continue;
    }

    match = /^v1\/users\/([^/]+)\/settings\.json$/.exec(key);
    if (match) {
      const userId = decodeSegment(match[1], key);
      if (userFilter && userId !== userFilter) continue;
      if ((object.size ?? 0) > 128 * 1024) throw new Error(`Settings object is too large: ${key}`);
      plan.blobs.push({
        remoteKey: key,
        localKey: `settings/${userId}`,
        userId,
        contentType: 'application/json',
        size: object.size,
      });
      continue;
    }

    plan.ignored.push(key);
  }

  const manuscripts = new Map(
    plan.manuscripts.map(({ record }) => [`${record.userId}\0${record.id}`, record.kind]),
  );
  for (const { key, record } of plan.chapters) {
    const parent = `${record.metadata.userId}\0${record.metadata.manuscriptId}`;
    const parentKind = manuscripts.get(parent);
    if (!parentKind) {
      throw new Error(`Chapter has no replicated manuscript metadata: ${key}`);
    }
    if (parentKind === 'manuscript-tombstone' && record.metadata.kind === 'chapter') {
      throw new Error(`Live chapter belongs to a deleted manuscript: ${key}`);
    }
  }
  // Cover objects are opaque and can outlive an older physical-delete
  // replica. Never hydrate one beneath an authoritative parent tombstone.
  const coverSafety = partitionRestoreBlobsForTombstones(plan.manuscripts, plan.blobs);
  plan.blobs = coverSafety.accepted;
  plan.ignored.push(...coverSafety.rejected.map((blob) => blob.remoteKey));
  return plan;
}

function restoreConflicts(plan: RestorePlan): string[] {
  const conflicts: string[] = [];
  for (const { record } of plan.manuscripts) {
    if (
      db.prepare('SELECT 1 FROM manuscripts WHERE user_id = ? AND id = ?')
        .get(record.userId, record.id)
    ) conflicts.push(`manuscript:${record.userId}/${record.id}`);
  }
  for (const { record } of plan.chapters) {
    const metadata = record.metadata;
    if (
      db.prepare(
        'SELECT 1 FROM chapters WHERE user_id = ? AND manuscript_id = ? AND id = ?',
      ).get(metadata.userId, metadata.manuscriptId, metadata.id)
    ) conflicts.push(`chapter:${metadata.userId}/${metadata.manuscriptId}/${metadata.id}`);
  }
  for (const { record } of plan.profiles) {
    if (db.prepare('SELECT 1 FROM profiles WHERE user_id = ?').get(record.userId)) {
      conflicts.push(`profile:${record.userId}`);
    }
  }
  for (const blob of plan.blobs) {
    if (db.prepare('SELECT 1 FROM storage_blobs WHERE key = ?').get(blob.localKey)) {
      conflicts.push(`blob:${blob.localKey}`);
    }
  }
  return conflicts;
}

async function hydrateRestoreBlobs(plan: RestorePlan): Promise<void> {
  let total = 0;
  for (const blob of plan.blobs) {
    const content = await fetchReplica(blob.remoteKey);
    total += content.length;
    if (total > 1024 * 1024 * 1024) {
      throw new Error('Restore blob payload exceeds the 1 GiB safety limit.');
    }
    if (blob.contentType === 'application/json') {
      if (content.length > 128 * 1024) {
        throw new Error(`Settings payload is too large: ${blob.remoteKey}`);
      }
      const parsed = parseJson(content, blob.remoteKey);
      if (!isObject(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) {
        throw new Error(`Settings payload is not a string map: ${blob.remoteKey}`);
      }
    } else {
      if (content.length > 8 * 1024 * 1024) {
        throw new Error(`Cover payload is too large: ${blob.remoteKey}`);
      }
      if (!validCoverBytes(content, blob.contentType)) {
        throw new Error(`Cover bytes do not match their extension: ${blob.remoteKey}`);
      }
    }
    blob.content = content;
  }
}

async function commandStatus(flags: Flags): Promise<void> {
  assertOnlyFlags(flags, []);
  try {
    await storage.initializeReplica();
  } catch {
    // getStatus includes the sanitized initialization error.
  }
  const status = storage.getStatus();
  console.log(JSON.stringify(status, null, 2));
  if (status.state === 'degraded') process.exitCode = 2;
}

async function commandVerify(flags: Flags): Promise<void> {
  assertOnlyFlags(flags, ['prefix']);
  const result = await storage.verify(flagString(flags, 'prefix') || '');
  console.log(JSON.stringify(result, null, 2));
  if (
    result.missing.length ||
    result.unexpected.length ||
    result.mismatched.length ||
    result.unverifiable.length
  ) {
    process.exitCode = 2;
  }
}

async function commandBackup(flags: Flags): Promise<void> {
  assertOnlyFlags(flags, ['output']);
  const requested = flagString(flags, 'output');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = requested
    ? path.resolve(requested)
    : path.join(config.dataDir, `chronicle-backup-${stamp}.db`);
  if (fs.existsSync(output)) {
    throw new Error(`Refusing to overwrite existing backup: ${output}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await db.backup(output);
  console.log(JSON.stringify({ backupPath: output }, null, 2));
}

async function commandRetry(flags: Flags): Promise<void> {
  assertOnlyFlags(flags, ['key']);
  const retried = storage.retryDeadLetters(flagString(flags, 'key'));
  await storage.processDue(1_000);
  console.log(JSON.stringify({ retried, status: storage.getStatus() }, null, 2));
}

async function commandSeed(flags: Flags): Promise<void> {
  assertOnlyFlags(flags, []);
  const database = seedPortableDatabaseManifest();
  const blobs = storage.seedLocalBlobs();
  const target = reconcileReplicaTarget();
  const manifest = storage.seedReplicaManifest();
  await storage.processDue(50);
  console.log(JSON.stringify({ database, blobs, target, manifest, status: storage.getStatus() }, null, 2));
}

async function commandRestore(flags: Flags): Promise<void> {
  assertOnlyFlags(flags, ['user', 'apply', 'force']);
  const apply = flags.get('apply') === true;
  const force = flags.get('force') === true;
  if (flags.has('apply') && flags.get('apply') !== true) throw new Error('--apply takes no value.');
  if (flags.has('force') && flags.get('force') !== true) throw new Error('--force takes no value.');
  const user = flagString(flags, 'user');
  const plan = await buildRestorePlan(user);
  const conflicts = restoreConflicts(plan);
  const summary = {
    dryRun: !apply,
    user: user || 'all',
    manuscripts: plan.manuscripts.length,
    chapters: plan.chapters.length,
    profiles: plan.profiles.length,
    blobs: plan.blobs.length,
    ignored: plan.ignored.length,
    conflicts: conflicts.length,
  };

  if (!apply) {
    console.log(JSON.stringify({ ...summary, conflictKeys: conflicts }, null, 2));
    return;
  }
  if (conflicts.length && !force) {
    throw new Error(
      `Restore would overwrite ${conflicts.length} existing record(s). ` +
      'Run the dry-run, then repeat with --apply --force if that is intentional.',
    );
  }

  await hydrateRestoreBlobs(plan);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(config.dataDir, `chronicle-before-restore-${stamp}.db`);
  await db.backup(backupPath);
  const applyResult = applyRestorePlan(plan);
  const databaseManifest = seedPortableDatabaseManifest();
  const target = reconcileReplicaTarget();
  db.pragma('wal_checkpoint(PASSIVE)');
  console.log(JSON.stringify({
    ...summary,
    dryRun: false,
    backupPath,
    ...applyResult,
    databaseManifest,
    target,
  }, null, 2));
}

async function main(): Promise<void> {
  const { command, flags } = parseArguments(process.argv.slice(2));
  if (flags.get('help') === true) {
    console.log(usage());
    return;
  }
  validateConfig({ listening: false });
  switch (command) {
    case 'status':
      await commandStatus(flags);
      break;
    case 'verify':
      await commandVerify(flags);
      break;
    case 'retry':
      await commandRetry(flags);
      break;
    case 'seed':
      await commandSeed(flags);
      break;
    case 'backup':
      await commandBackup(flags);
      break;
    case 'restore':
      await commandRestore(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(usage());
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    storage.close();
    if (db.open) db.close();
  });
