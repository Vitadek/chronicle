import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';

// Prefer chronicle.db (current name) but keep an existing scribe.db (legacy
// name from before the rename) working for upgrade compatibility. If a user
// is sitting on data the original install wrote, we open it in place.
const PRIMARY_DB = 'chronicle.db';
const LEGACY_DB = 'scribe.db';
const primaryPath = path.join(config.dataDir, PRIMARY_DB);
const legacyPath = path.join(config.dataDir, LEGACY_DB);
const dbPath = fs.existsSync(primaryPath) || !fs.existsSync(legacyPath)
  ? primaryPath
  : legacyPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

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

/** Run periodically: clear tombstones, expired sessions, expired kv entries. */
export function gc(): void {
  const cutoff = Date.now() - config.tombstoneRetentionMs;
  db.prepare('DELETE FROM manuscripts WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff);
  db.prepare('DELETE FROM chapters    WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff);
  db.prepare('DELETE FROM sessions    WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM kv          WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());
}
gc();
setInterval(gc, 1000 * 60 * 60 * 24).unref();
