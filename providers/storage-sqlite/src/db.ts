/**
 * Opening the library database: pragmas, versioned migrations and the FTS5
 * index. Every write in this package runs synchronously inside one
 * transaction, with no await in between, so a lock is never held across
 * event-loop turns and other connections only ever wait for busy_timeout.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type Env, Vid2ContextError } from '@vid2context/core';

/**
 * node:sqlite, looked up at runtime: Node 22 before 22.13 hides it behind a
 * flag, and a static import would then break every package that loads the
 * provider registry. Without it the backend reports itself disabled.
 */
const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined;

export function sqliteAvailable(): boolean {
  return typeof sqlite?.DatabaseSync === 'function';
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Resolves the database path from env: VID2CONTEXT_DB, else <VID2CONTEXT_HOME or .vid2context>/library.db. */
export function databasePath(env: Env): string {
  const explicit = env.VID2CONTEXT_DB?.trim();
  if (explicit) return explicit === ':memory:' ? explicit : resolve(explicit);
  const home = env.VID2CONTEXT_HOME?.trim() || '.vid2context';
  return resolve(home, 'library.db');
}

/** Runs fn inside BEGIN IMMEDIATE ... COMMIT, rolling back on any error. fn must be synchronous. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite already rolled back (for example after SQLITE_FULL); keep the original error.
    }
    throw err;
  }
}

/**
 * Schema migrations, applied in order. Index i moves the database from
 * user_version i to i + 1. Never edit or reorder an existing entry, and never
 * drop user data: add a new entry instead. Each one is idempotent.
 */
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        ref TEXT NOT NULL,
        title TEXT NOT NULL,
        channel TEXT,
        duration_sec REAL,
        origin TEXT NOT NULL,
        language TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        context TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS videos_saved_at ON videos (saved_at DESC, id DESC);

      -- seg_id is an explicit INTEGER PRIMARY KEY so rowids stay stable across
      -- VACUUM: the external-content FTS index refers to them.
      CREATE TABLE IF NOT EXISTS segments (
        seg_id INTEGER PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        start_sec REAL NOT NULL,
        end_sec REAL NOT NULL,
        text TEXT NOT NULL,
        speaker TEXT,
        UNIQUE (video_id, idx)
      );

      CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        sources TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- video_id has no foreign key: like MemoryStorage, a collection may list
      -- videos that are not saved yet (a playlist being filled in).
      CREATE TABLE IF NOT EXISTS collection_items (
        collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
        video_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (collection_id, video_id)
      );
      CREATE INDEX IF NOT EXISTS collection_items_video ON collection_items (video_id);

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS kv_expires_at ON kv (expires_at) WHERE expires_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT NOT NULL,
        model TEXT NOT NULL,
        video_id TEXT NOT NULL,
        start_sec REAL NOT NULL,
        end_sec REAL NOT NULL,
        text TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (model, id)
      );
      CREATE INDEX IF NOT EXISTS vectors_video ON vectors (video_id, model);
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/** Applies pending migrations, each in its own transaction. Safe when several connections open the file at once. */
export function migrate(db: DatabaseSync, path: string): number {
  const start = userVersion(db);
  if (start > SCHEMA_VERSION) {
    throw new Vid2ContextError(
      'unavailable',
      `The library at ${path} uses schema version ${start}; this vid2context knows up to ${SCHEMA_VERSION}.`,
      { hint: 'Upgrade vid2context, or point VID2CONTEXT_DB at another file.' },
    );
  }
  for (let v = start; v < SCHEMA_VERSION; v++) {
    transaction(db, () => {
      // Another connection may have migrated while we waited for the write lock.
      if (userVersion(db) !== v) return;
      MIGRATIONS[v]?.(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return userVersion(db);
}

/** True when this SQLite build has FTS5. Probes with a temporary virtual table, so nothing is written to the file. */
export function hasFts5(db: DatabaseSync): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.vid2context_fts5_probe USING fts5(x)');
    db.exec('DROP TABLE temp.vid2context_fts5_probe');
    return true;
  } catch {
    return false;
  }
}

const FTS_TRIGGERS = ['segments_ai', 'segments_ad', 'segments_au'];

function objectExists(db: DatabaseSync, type: 'table' | 'trigger', name: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !== undefined;
}

/**
 * Keeps segments_fts in step with segments. With FTS5 in this build, creates the
 * index and its triggers when missing and rebuilds it from segments (the
 * index is derived data, segments stay the source of truth). Without FTS5,
 * removes the triggers so writes still work; the next FTS5-capable open
 * rebuilds the index.
 */
export function ensureFts(db: DatabaseSync, available: boolean): void {
  if (!available) {
    const present = FTS_TRIGGERS.filter((t) => objectExists(db, 'trigger', t));
    if (present.length) {
      transaction(db, () => {
        for (const t of present) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
      });
    }
    return;
  }
  const complete = objectExists(db, 'table', 'segments_fts') && FTS_TRIGGERS.every((t) => objectExists(db, 'trigger', t));
  if (complete) return;
  transaction(db, () => {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5 (
        text,
        content = 'segments',
        content_rowid = 'seg_id',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
        INSERT INTO segments_fts (rowid, text) VALUES (new.seg_id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
        INSERT INTO segments_fts (segments_fts, rowid, text) VALUES ('delete', old.seg_id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE ON segments BEGIN
        INSERT INTO segments_fts (segments_fts, rowid, text) VALUES ('delete', old.seg_id, old.text);
        INSERT INTO segments_fts (rowid, text) VALUES (new.seg_id, new.text);
      END;
      INSERT INTO segments_fts (segments_fts) VALUES ('rebuild');
    `);
  });
}

export interface OpenOptions {
  /** File path or ':memory:'. */
  path: string;
  busyTimeoutMs?: number;
  /**
   * Set false to search with LIKE even when FTS5 is available (for
   * troubleshooting). The FTS index is still maintained when FTS5 exists.
   */
  fts?: boolean;
}

export interface OpenedDatabase {
  db: DatabaseSync;
  path: string;
  fts: boolean;
  version: number;
}

/** Opens (creating when needed) and migrates the library database. */
export function openDatabase(opts: OpenOptions): OpenedDatabase {
  const path = opts.path;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  if (!sqlite) {
    throw new Vid2ContextError('unavailable', 'node:sqlite is not available in this Node.js build.', {
      hint: 'Use Node.js 22.13 or newer, or set VID2CONTEXT_STORAGE=memory.',
    });
  }
  let db: DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(path);
  } catch (err) {
    throw new Vid2ContextError('unavailable', `Cannot open the library database at ${path}: ${(err as Error).message}`, {
      hint: 'Check that the directory is writable, or set VID2CONTEXT_DB to another path.',
      cause: err,
    });
  }
  try {
    const busy = Math.max(0, Math.floor(opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
    db.exec(`PRAGMA busy_timeout = ${busy}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    const version = migrate(db, path);
    const available = hasFts5(db);
    ensureFts(db, available);
    return { db, path, fts: available && opts.fts !== false, version };
  } catch (err) {
    db.close();
    throw err;
  }
}
