/**
 * D1 schema. Each migration is a list of statements, applied in one batch.
 * The same statements live in providers/storage-cloudflare/migrations/*.sql
 * for `wrangler d1 migrations apply`; a test keeps the two byte-identical.
 * Every statement is idempotent, so a database migrated by wrangler and one
 * migrated at startup end up the same, and the last statement records the
 * version in schema_version.
 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '0001_init',
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  channel TEXT,
  duration_sec REAL,
  origin TEXT NOT NULL,
  language TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  context TEXT,
  r2_key TEXT
)`,
      `CREATE INDEX IF NOT EXISTS videos_saved_at ON videos (saved_at DESC, id DESC)`,
      `CREATE TABLE IF NOT EXISTS segments (
  video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  UNIQUE (video_id, idx)
)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5 (
  text,
  content = 'segments',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
)`,
      `CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts (rowid, text) VALUES (new.rowid, new.text);
END`,
      `CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts (segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END`,
      `CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts (segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO segments_fts (rowid, text) VALUES (new.rowid, new.text);
END`,
      `CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (collection_id, video_id)
)`,
      `CREATE INDEX IF NOT EXISTS collection_items_video ON collection_items (video_id)`,
      `CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
)`,
      `CREATE TABLE IF NOT EXISTS vector_chunks (
  vector_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  model TEXT NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  text TEXT NOT NULL
)`,
      `CREATE INDEX IF NOT EXISTS vector_chunks_video ON vector_chunks (video_id, model)`,
      `INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** The .sql file content for a migration, as `wrangler d1 migrations apply` reads it. */
export function migrationSql(m: Migration): string {
  return `-- ${m.name}: generated from src/migrations.ts; keep the two identical (a test checks).\n${m.statements.map((s) => `${s};\n`).join('\n')}`;
}
