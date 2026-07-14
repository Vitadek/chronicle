import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';

/**
 * Whole-database backup/restore for a single-user instance — the file mechanics
 * behind the `.chron` export/import (see server/routes/backup.ts).
 *
 * A `.chron` file is simply an xz-compressed SQLite backup of the live database.
 * Restore is deliberately NOT a live hot-swap: the running server holds an open
 * handle (and a WAL) on chronicle.db, and every module imports that one handle,
 * so replacing the file underneath it is unsafe. Instead an import is *staged*
 * next to the DB with a marker, and the swap happens once at boot in
 * server/db.ts — before any connection is opened (`applyPendingImport`). The
 * desktop shell restarts the Node sidecar after an import; a plain server picks
 * it up on its next start.
 *
 * Kept dependency-free on purpose: compression shells out to the `xz` binary
 * (present in the Flatpak runtime and virtually every Linux). If a future target
 * lacks it, swap `xz`/`xz -d` for Node's zlib brotli here and bump the format.
 */

const PRIMARY_DB = 'chronicle.db';
const STAGED_IMPORT = 'import-staged.db';
const IMPORT_MARKER = 'import-staged.marker';

export function primaryDbPath(dataDir: string): string {
  return path.join(dataDir, PRIMARY_DB);
}
function stagedImportPath(dataDir: string): string {
  return path.join(dataDir, STAGED_IMPORT);
}
function importMarkerPath(dataDir: string): string {
  return path.join(dataDir, IMPORT_MARKER);
}

/** Timestamp for backup filenames, matching the CLI's `chronicle-backup-*`. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Pipe a buffer through a spawned binary and collect stdout. */
function runFilter(cmd: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject); // e.g. xz not installed
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`));
    });
    child.stdin.on('error', () => { /* the child may close its pipe early on error */ });
    child.stdin.end(input);
  });
}

/**
 * Produce a `.chron`: a consistent SQLite snapshot (better-sqlite3's online
 * backup, so it's safe against the live WAL) compressed with xz. Runs only when
 * called — there is no idle/background compression (explicit-consent rule).
 */
export async function exportChron(db: Database.Database, dataDir: string): Promise<Buffer> {
  const tmp = path.join(dataDir, `export-${stamp()}.db`);
  try {
    await db.backup(tmp);
    const raw = fs.readFileSync(tmp);
    return await runFilter('xz', ['-z', '-c', '-T0'], raw);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Validate + stage an uploaded `.chron`. Decompresses, checks the bytes are a
 * Chronicle SQLite database (magic + the tables a real instance always has),
 * takes a safety backup of the CURRENT database, then writes the decompressed
 * DB to the staged path and drops the marker. Nothing live is touched — the
 * swap is `applyPendingImport` at the next boot.
 *
 * @returns the path of the safety backup that was written.
 */
export async function stageImportChron(
  db: Database.Database,
  dataDir: string,
  compressed: Buffer,
): Promise<{ safetyBackup: string }> {
  const decompressed = await runFilter('xz', ['-d', '-c'], compressed).catch(() => {
    throw new Error('Not a valid .chron file (could not decompress).');
  });
  if (!decompressed.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    throw new Error('Not a valid .chron file (not a SQLite database).');
  }

  // Prove it's a Chronicle DB, not some other SQLite file, before we let it
  // replace the user's data. Open a throwaway read-only handle off a temp copy.
  const probe = path.join(dataDir, `import-probe-${stamp()}.db`);
  fs.writeFileSync(probe, decompressed);
  try {
    const ro = new Database(probe, { readonly: true });
    try {
      const tables = new Set(
        (ro.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map((r) => r.name),
      );
      for (const required of ['schema_migrations', 'manuscripts', 'chapters']) {
        if (!tables.has(required)) {
          throw new Error(`Not a Chronicle backup (missing "${required}" table).`);
        }
      }
    } finally {
      ro.close();
    }
  } finally {
    fs.rmSync(probe, { force: true });
  }

  // Safety net before anything destructive: a hot backup of the live DB, named
  // like the CLI's pre-restore backup so recovery is familiar.
  const safetyBackup = path.join(dataDir, `chronicle-before-restore-${stamp()}.db`);
  await db.backup(safetyBackup);

  // Stage atomically: write to a temp name, then rename into place.
  const staging = stagedImportPath(dataDir);
  const tmp = `${staging}.partial`;
  fs.writeFileSync(tmp, decompressed);
  fs.renameSync(tmp, staging);
  fs.writeFileSync(importMarkerPath(dataDir), `${Date.now()}\n`);

  return { safetyBackup };
}

/**
 * Boot-time swap. Called at the top of server/db.ts BEFORE the database is
 * opened: if an import is staged, replace chronicle.db (and clear its stale
 * WAL/SHM) with the staged file, then remove the marker. Idempotent and safe to
 * call every boot.
 *
 * @returns true if a swap was applied.
 */
export function applyPendingImport(dataDir: string): boolean {
  const marker = importMarkerPath(dataDir);
  const staged = stagedImportPath(dataDir);
  if (!fs.existsSync(marker) || !fs.existsSync(staged)) {
    // A lone marker or lone staged file is an interrupted stage — clean both so
    // we never half-apply.
    fs.rmSync(marker, { force: true });
    fs.rmSync(staged, { force: true });
    return false;
  }
  const primary = primaryDbPath(dataDir);
  // The staged file is a standalone backup with no WAL; drop the old sidecars
  // so a stale WAL can't be replayed over the freshly imported database.
  fs.rmSync(`${primary}-wal`, { force: true });
  fs.rmSync(`${primary}-shm`, { force: true });
  fs.renameSync(staged, primary);
  fs.rmSync(marker, { force: true });
  return true;
}
