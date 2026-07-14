import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { applyPendingImport } from './lib/localBackup';

// Prefer chronicle.db (current name) but keep an existing scribe.db (legacy
// name from before the rename) working for upgrade compatibility. If a user
// is sitting on data the original install wrote, we open it in place.
const PRIMARY_DB = 'chronicle.db';
const LEGACY_DB = 'scribe.db';
const primaryPath = path.join(config.dataDir, PRIMARY_DB);
const legacyPath = path.join(config.dataDir, LEGACY_DB);
fs.mkdirSync(config.dataDir, { recursive: true });

// A staged `.chron` import is applied HERE, before any connection opens — it
// renames the staged database over chronicle.db (see server/lib/localBackup.ts).
// Doing it pre-open is what makes restore safe: no live handle, no WAL to
// reconcile. After this the primary path is authoritative, so resolve dbPath
// after the swap.
if (applyPendingImport(config.dataDir)) {
  console.log('[db] applied a staged .chron import');
}

const dbPath = fs.existsSync(primaryPath) || !fs.existsSync(legacyPath)
  ? primaryPath
  : legacyPath;

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function scrubRetainedTombstonePayloads(d: Database.Database): void {
  // Tombstones are convergence markers, not an indefinite archive of the
  // author's deleted prose. This routine is deliberately idempotent: migration
  // 008 upgrades existing databases, and the startup pass also repairs any
  // inconsistent rows introduced by an interrupted/older external restore.
  const deletedManuscripts = d.prepare(`
    SELECT user_id, id, deleted_at FROM manuscripts WHERE deleted_at IS NOT NULL
  `).all() as Array<{ user_id: string; id: string; deleted_at: number }>;
  const scrubManuscript = d.prepare(
    'UPDATE manuscripts SET data = ? WHERE user_id = ? AND id = ? AND data <> ?',
  );
  const liveChildren = d.prepare(`
    SELECT id, last_modified, revision FROM chapters
    WHERE user_id = ? AND manuscript_id = ? AND deleted_at IS NULL
  `);
  const tombstoneChild = d.prepare(`
    UPDATE chapters
       SET title = NULL, content = NULL, position = NULL,
           last_modified = ?, deleted_at = ?, revision = ?
     WHERE user_id = ? AND manuscript_id = ? AND id = ? AND deleted_at IS NULL
  `);
  const logChildDelete = d.prepare(`
    INSERT INTO change_log(
      user_id, entity, manuscript_id, record_id, operation, revision, changed_at
    ) VALUES (?, 'chapter', ?, ?, 'delete', ?, ?)
  `);
  const deleteYdoc = d.prepare('DELETE FROM ydocs WHERE name = ?');
  const deleteYdocPrefix = d.prepare(
    'DELETE FROM ydocs WHERE substr(name, 1, ?) = ?',
  );

  for (const row of deletedManuscripts) {
    const minimal = JSON.stringify({ id: row.id });
    scrubManuscript.run(minimal, row.user_id, row.id, minimal);
    const children = liveChildren.all(row.user_id, row.id) as Array<{
      id: string;
      last_modified: number;
      revision: number;
    }>;
    for (const child of children) {
      const changedAt = Math.max(row.deleted_at, child.last_modified);
      const revision = child.revision + 1;
      const result = tombstoneChild.run(
        changedAt,
        changedAt,
        revision,
        row.user_id,
        row.id,
        child.id,
      );
      if (result.changes === 1) {
        logChildDelete.run(
          row.user_id,
          row.id,
          child.id,
          revision,
          changedAt,
        );
      }
    }
    const scopedPrefix = `${encodeURIComponent(row.user_id)}/${row.id}:`;
    deleteYdocPrefix.run(scopedPrefix.length, scopedPrefix);
    // Historical clients used unscoped names in every auth mode. Such rows
    // are globally ambiguous, so purge the legacy prefix for any owner.
    const legacyPrefix = `${row.id}:`;
    deleteYdocPrefix.run(legacyPrefix.length, legacyPrefix);
  }

  const deletedChapters = d.prepare(`
    SELECT user_id, manuscript_id, id
    FROM chapters WHERE deleted_at IS NOT NULL
  `).all() as Array<{ user_id: string; manuscript_id: string; id: string }>;
  for (const row of deletedChapters) {
    deleteYdoc.run(
      `${encodeURIComponent(row.user_id)}/${row.manuscript_id}:${row.id}`,
    );
    deleteYdoc.run(`${row.manuscript_id}:${row.id}`);
  }
  d.exec(`
    UPDATE chapters
       SET title = NULL, content = NULL, position = NULL
     WHERE deleted_at IS NOT NULL
       AND (title IS NOT NULL OR content IS NOT NULL OR position IS NOT NULL);

    DELETE FROM chapter_pre_collab
     WHERE EXISTS (
       SELECT 1 FROM manuscripts m
        WHERE m.user_id = chapter_pre_collab.user_id
          AND m.id = chapter_pre_collab.manuscript_id
          AND m.deleted_at IS NOT NULL
     ) OR EXISTS (
       SELECT 1 FROM chapters c
        WHERE c.user_id = chapter_pre_collab.user_id
          AND c.manuscript_id = chapter_pre_collab.manuscript_id
          AND c.id = chapter_pre_collab.chapter_id
          AND c.deleted_at IS NOT NULL
     );
  `);
}

/**
 * Migrations.
 *
 * Forward-only, applied in order, recorded in schema_migrations. Each entry
 * is a single transaction; if anything throws, the DB is left at the prior
 * version. Adding columns is fine for SQLite; renaming/dropping needs the
 * full table-rebuild dance.
 */
const migrations: Array<{ name: string; up: (db: Database.Database) => void }> = [
  {
    name: '001_init',
    up: (d) => {
      d.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            TEXT PRIMARY KEY,
          email         TEXT UNIQUE,
          display_name  TEXT,
          created_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          token             TEXT PRIMARY KEY,
          user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          nc_access_token   TEXT,
          nc_refresh_token  TEXT,
          nc_expires_at     INTEGER,
          expires_at        INTEGER NOT NULL,
          created_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

        CREATE TABLE IF NOT EXISTS manuscripts (
          user_id        TEXT NOT NULL,
          id             TEXT NOT NULL,
          data           TEXT NOT NULL,
          last_modified  INTEGER NOT NULL,
          deleted_at     INTEGER,
          PRIMARY KEY (user_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_manuscripts_sync
          ON manuscripts(user_id, last_modified);

        CREATE TABLE IF NOT EXISTS chapters (
          user_id        TEXT NOT NULL,
          manuscript_id  TEXT NOT NULL,
          id             TEXT NOT NULL,
          title          TEXT,
          content        TEXT,
          position       INTEGER,
          last_modified  INTEGER NOT NULL,
          deleted_at     INTEGER,
          PRIMARY KEY (user_id, manuscript_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_chapters_sync
          ON chapters(user_id, last_modified);

        CREATE TABLE IF NOT EXISTS profiles (
          user_id        TEXT PRIMARY KEY,
          data           TEXT NOT NULL,
          last_modified  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kv (
          k          TEXT PRIMARY KEY,
          v          TEXT NOT NULL,
          expires_at INTEGER
        );
      `);
    },
  },
  {
    name: '002_external_identity',
    up: (d) => {
      // Generic external identity columns. NC fields stay for the WebDAV
      // mirror flow specifically; they're not the only way to log in anymore.
      d.exec(`
        ALTER TABLE users ADD COLUMN external_provider TEXT;
        ALTER TABLE users ADD COLUMN external_issuer   TEXT;
        ALTER TABLE users ADD COLUMN external_id       TEXT;
        ALTER TABLE users ADD COLUMN nc_user_id        TEXT;
        ALTER TABLE users ADD COLUMN nc_url            TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external
          ON users(external_provider, external_issuer, external_id)
          WHERE external_id IS NOT NULL;
      `);
    },
  },
  {
    name: '003_plugin_system',
    up: (d) => {
      d.exec(`
        CREATE TABLE IF NOT EXISTS plugin_states (
          user_id        TEXT NOT NULL,
          id             TEXT NOT NULL,
          plugin_id      TEXT NOT NULL,
          manuscript_id  TEXT,
          enabled        INTEGER DEFAULT 1,
          state          TEXT NOT NULL DEFAULT '{}',
          last_modified  INTEGER NOT NULL,
          PRIMARY KEY (user_id, id),
          FOREIGN KEY(manuscript_id) REFERENCES manuscripts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_states_sync 
          ON plugin_states(user_id, last_modified);
      `);
    },
  },
  {
    name: '004_fix_plugin_states_fk',
    up: (d) => {
      // The previous migration had a FK mismatch (manuscripts has a composite PK).
      // We drop and recreate since it's a new table with no critical data yet.
      d.exec(`
        DROP TABLE IF EXISTS plugin_states;
        CREATE TABLE plugin_states (
          user_id        TEXT NOT NULL,
          id             TEXT NOT NULL,
          plugin_id      TEXT NOT NULL,
          manuscript_id  TEXT,
          enabled        INTEGER DEFAULT 1,
          state          TEXT NOT NULL DEFAULT '{}',
          last_modified  INTEGER NOT NULL,
          PRIMARY KEY (user_id, id),
          FOREIGN KEY(user_id, manuscript_id) REFERENCES manuscripts(user_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_states_sync 
          ON plugin_states(user_id, last_modified);
      `);
    },
  },
  {
    name: '005_collab_ydocs',
    up: (d) => {
      // Yjs/CRDT document store: one row per collaborative document
      // (documentName = a chapter id). `data` is the encoded Y.Doc state
      // persisted by Hocuspocus and is the source of truth for live editing.
      d.exec(`
        CREATE TABLE IF NOT EXISTS ydocs (
          name        TEXT PRIMARY KEY,
          data        BLOB NOT NULL,
          updated_at  INTEGER NOT NULL
        );
      `);
    },
  },
  {
    name: '006_chapter_pre_collab',
    up: (d) => {
      // A chapter's original HTML, captured once before the first collab
      // snapshot overwrites it — so pre-collab prose is always recoverable.
      d.exec(`
        CREATE TABLE IF NOT EXISTS chapter_pre_collab (
          user_id        TEXT NOT NULL,
          manuscript_id  TEXT NOT NULL,
          chapter_id     TEXT NOT NULL,
          content        TEXT NOT NULL,
          backed_up_at   INTEGER NOT NULL,
          PRIMARY KEY (user_id, manuscript_id, chapter_id)
        );
      `);
    },
  },
  {
    name: '007_record_revisions',
    up: (d) => {
      // Client wall clocks are not safe concurrency tokens: a device with a
      // fast clock can otherwise win forever, and a pull cursor based on time
      // can skip a later write. Revisions guard individual records while the
      // append-only sequence below gives sync a monotonic server cursor.
      d.exec(`
        ALTER TABLE manuscripts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE chapters    ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE profiles    ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

        CREATE TABLE change_log (
          seq            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id        TEXT NOT NULL,
          entity         TEXT NOT NULL,
          manuscript_id  TEXT,
          record_id      TEXT NOT NULL,
          operation      TEXT NOT NULL,
          revision       INTEGER NOT NULL,
          changed_at     INTEGER NOT NULL
        );
        CREATE INDEX idx_change_log_user_seq
          ON change_log(user_id, seq);
      `);

      // Existing rows pre-date the log. Seed one entry per row so a v2 client
      // starting at cursor 0 receives the complete current state, including
      // any tombstones that are already present.
      const now = Date.now();
      d.prepare(`
        INSERT INTO change_log
          (user_id, entity, manuscript_id, record_id, operation, revision, changed_at)
        SELECT user_id, 'manuscript', NULL, id,
               CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
               revision, ?
          FROM manuscripts
      `).run(now);
      d.prepare(`
        INSERT INTO change_log
          (user_id, entity, manuscript_id, record_id, operation, revision, changed_at)
        SELECT user_id, 'chapter', manuscript_id, id,
               CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
               revision, ?
          FROM chapters
      `).run(now);
      d.prepare(`
        INSERT INTO change_log
          (user_id, entity, manuscript_id, record_id, operation, revision, changed_at)
        SELECT user_id, 'profile', NULL, 'profile', 'upsert', revision, ?
          FROM profiles
      `).run(now);
    },
  },
  {
    name: '008_scrub_tombstone_payloads',
    up: scrubRetainedTombstonePayloads,
  },
];

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    )
  `);
  const seen = db.prepare('SELECT name FROM schema_migrations').all() as Array<{
    name: string;
  }>;
  const applied = new Set(seen.map((r) => r.name));

  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
      ).run(m.name, Date.now());
    });
    tx();
    console.log(`[db] applied migration ${m.name}`);
  }
}
runMigrations();
// Keep the scrub as a cheap idempotent startup invariant in addition to the
// versioned migration, so manually restored/corrupted tombstone payloads do not
// survive merely because migration 008 was already recorded.
db.transaction(() => scrubRetainedTombstonePayloads(db))();

/** Synthetic user for AUTH_MODE=none and AUTH_MODE=token. */
export const LOCAL_USER_ID = 'local';
const localExists = db
  .prepare('SELECT id FROM users WHERE id = ?')
  .get(LOCAL_USER_ID);
if (!localExists) {
  db.prepare(
    'INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)',
  ).run(LOCAL_USER_ID, 'Local User', Date.now());
}

/**
 * Run periodically: clear credentials/temporary state.
 *
 * Manuscript and chapter tombstones are deliberately retained. Without a
 * per-device acknowledgement registry, deleting them after an arbitrary time
 * lets an old offline client recreate data the author deleted. Chronicle data
 * is tiny compared with the prose itself; correctness wins over this marginal
 * space saving until safe, cursor-aware compaction exists.
 */
export function gc(): void {
  db.prepare('DELETE FROM sessions    WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM kv          WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());
}
gc();
setInterval(gc, 1000 * 60 * 60 * 24).unref();
