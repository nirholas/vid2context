# Library on Postgres and pgvector

`@vid2context/provider-storage-postgres` keeps the library (saved contexts, collections, full-text search, key-value state and embedding vectors) in Postgres. Use it for a hosted or multi-user deployment. For one person on one machine, the SQLite library ([library-sqlite.md](library-sqlite.md)) is simpler and is the default.

It implements the same `Storage` contract as every other backend, plus `KvStore` and `VectorStore`, so the CLI, MCP server, HTTP API and web app need no changes.

## Turn it on

Set a connection string and start any surface:

```sh
export VID2CONTEXT_DATABASE_URL='postgres://user:password@host:5432/dbname?sslmode=require'
npm run cli -- https://www.youtube.com/watch?v=jNQXAC9IVRw
```

- `VID2CONTEXT_DATABASE_URL` wins over `DATABASE_URL`. Use the first when `DATABASE_URL` already belongs to another app.
- With a URL set, Postgres (priority 10) takes over from SQLite (50) and D1 (20).
- `VID2CONTEXT_STORAGE=postgres` forces it (and fails with a clear error when no URL is set). Any other `VID2CONTEXT_STORAGE` value turns it off.
- On first start it creates the schema `vid2context` (or `VID2CONTEXT_PG_SCHEMA`), enables the `vector` extension and creates its tables. Nothing else in the database is touched.

Requirements: Postgres 13 or newer with pgvector 0.7 or newer (0.8 or newer recommended, see [Vector search](#vector-search)).

## Where to run Postgres, free first

### Local Docker (free, offline)

```sh
docker run -d --name vid2context-pg -p 127.0.0.1:5432:5432 \
  -e POSTGRES_PASSWORD=change-me -v vid2context-pg:/var/lib/postgresql/data \
  pgvector/pgvector:pg17
export VID2CONTEXT_DATABASE_URL='postgres://postgres:change-me@127.0.0.1:5432/postgres'
```

The `pgvector/pgvector` image is the official Postgres image with pgvector built in. No `sslmode` is needed on localhost.

### Neon (free tier)

Create a project at neon.tech and copy the connection string from the dashboard. It looks like:

```
postgres://user:password@ep-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
```

pgvector is available on every Neon project; the storage enables it itself. Neon is also the only option on Cloudflare Workers (see [Workers](#cloudflare-workers)). For a long-running Node server either the direct or the pooled (`-pooler`) host works.

### Supabase (free tier)

In the project settings, open the database connection strings.

- Session mode (port 5432) or the direct connection: use these for a long-running server.
- Transaction mode (port 6543): fine too. The driver never uses named prepared statements, which transaction poolers reject. Leave `VID2CONTEXT_PG_STATEMENT_TIMEOUT_MS` unset behind it.

Append `?sslmode=require`. pgvector is available; the storage runs `create extension if not exists vector` on first start. If your role may not create extensions, enable "vector" under Database, Extensions first.

### Google Cloud SQL (paid)

Cloud SQL for PostgreSQL supports pgvector. Connect through the Cloud SQL Auth Proxy (`postgres://user:password@127.0.0.1:5432/db`) or a private IP with `?sslmode=require`. The first start must run as a user that may create extensions (a member of `cloudsqlsuperuser`); after that a regular user with rights on the schema is enough.

### Railway (paid)

Deploy a Postgres service with pgvector (the pgvector template or the `pgvector/pgvector` image) and use its `DATABASE_URL` variable. Railway's plain Postgres image may not include pgvector; if the first start fails with "pgvector is not installed", switch the image.

### Alibaba Cloud ApsaraDB RDS for PostgreSQL (paid)

ApsaraDB RDS for PostgreSQL ships pgvector as the `vector` extension. Create a database and an account, add your server's address to the whitelist, and use the internal endpoint from inside the same VPC:

```
postgres://account:password@pgm-xxxx.pg.rds.aliyuncs.com:5432/vid2context?sslmode=require
```

If extension creation is restricted for your account, create `vector` once from the console or as the privileged account.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `VID2CONTEXT_DATABASE_URL` | | Connection string. Wins over `DATABASE_URL`. SSL comes from `?sslmode=` |
| `DATABASE_URL` | | Used when `VID2CONTEXT_DATABASE_URL` is unset |
| `VID2CONTEXT_PG_SCHEMA` | `vid2context` | Schema for all tables. Lowercase letters, digits, underscores |
| `VID2CONTEXT_TENANT` | `default` | Tenant this instance reads and writes (see [Tenancy](#tenancy)) |
| `VID2CONTEXT_PG_POOL_MAX` | `10` | Connections in the Node pool |
| `VID2CONTEXT_PG_STATEMENT_TIMEOUT_MS` | server default | Per-statement timeout, sent when connecting. PgBouncer-style poolers reject it |
| `VID2CONTEXT_PG_DRIVER` | `postgres` on Node, `neon-http` on Workers | `postgres` is postgres.js over TCP; `neon-http` is Neon's HTTPS driver |
| `VID2CONTEXT_PG_NEON_FETCH_ENDPOINT` | Neon's | HTTP endpoint for a local Neon proxy or a self-hosted Neon |

The connection string never appears in logs or error messages: errors scrub it and its password, and say which variable to check.

## Tenancy

Every table has a `tenant_id` column, every primary key starts with it, and every query filters by it. An instance is bound to one tenant, `VID2CONTEXT_TENANT`, when it is created. Two deployments with different tenants can share one database and schema without seeing each other's videos, collections, keys or vectors, even when they save the same video id.

A multi-user server can keep one pool and switch per request:

```ts
import { openPostgresStorage } from '@vid2context/provider-storage-postgres';

const base = await openPostgresStorage(ctx); // tenant from VID2CONTEXT_TENANT
const forUser = base.forTenant(`user:${userId}`); // same pool, other tenant
```

Tenant ids are plain strings up to 200 characters. Choosing and authenticating them is the caller's job (see hosted mode).

## Tables and indexes

| Table | Holds |
|---|---|
| `videos` | one row per saved video: the summary columns and the full `VideoContext` as JSONB, raw transcript included |
| `segments` | one row per transcript segment, with a generated `tsv tsvector` column and a GIN index |
| `collections`, `collection_items` | collections and their ordered members |
| `kv` | key-value state (JSONB values, optional expiry); keys use the C collation so prefix listing is an index range scan |
| `vector_models` | each embedding model and its dimension count |
| `vectors` | embedded chunks: model, video, times, text, `embedding vector` |
| `schema_migrations` | applied migration versions |

### Full-text search

Each video's segments are indexed with the Postgres text search configuration of its transcript language (`english` for `en`, `german` for `de`, and so on; languages without one, such as Chinese or Japanese, use `simple`). Stemming means a search for "elephant" finds "elephants".

`search()` parses the query with `websearch_to_tsquery`, which accepts any input without errors:

| Input | Means |
|---|---|
| `long trunks` | both words |
| `"long trunks"` | the phrase |
| `elephants or transmission` | either word |
| `really -trunks` | "really" but not "trunks" |

Results are ranked by `ts_rank_cd`, normalised to 0 to 1. Each hit has the raw segment in `text` and a `snippet` with the matches wrapped in `**`.

### Vector search

Vectors of different models are never compared. The `embedding` column has no fixed size so one table holds every model, and the storage creates one partial HNSW index per model on first use:

```sql
CREATE INDEX vectors_hnsw_<hash> ON vectors
  USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
  WHERE model = 'embed/ovh/bge-m3';
```

Why this design: one table keeps tenancy, deletes and backups simple, while the partial expression index gives each model its own graph with the right dimension. Queries repeat the same expression and put the model name in as a literal, so the planner can match the index. On a real Postgres 17 with pgvector this is the plan for a library query:

```
Limit
  ->  Index Scan using vectors_hnsw_6559e8beb945e022 on vectors
        Order By: ((embedding)::vector(1024) <=> '[...]'::vector(1024))
        Filter: (tenant_id = 'plan'::text)
```

Details:

- Models with more than 2,000 dimensions use a `halfvec` index (up to 4,000). Larger vectors are stored and searched exactly, without an index.
- A model keeps one dimension count. Sending a different size for the same model id is an error; give the other embedding a different model id.
- The tenant and video filters apply while the graph is scanned. pgvector 0.8 and newer keeps scanning until enough rows pass the filters (`hnsw.iterative_scan`). On older pgvector, or when a filter is very selective, a query that comes back short is rerun as an exact scan, so results are always complete.
- Scores are cosine similarity, -1 to 1.

`storage.vectorQuerySql(query)` returns the exact statements a query runs, so you can `EXPLAIN` it on your own data.

## Migrations

Migrations are versioned SQL files in `providers/storage-postgres/migrations/` (`0001_library.sql`, ...). They only ever add things. They are applied automatically on start:

1. A quick read of `schema_migrations`. When it is current, nothing else runs, so a role without DDL rights can use a schema someone else migrated.
2. Otherwise one transaction takes `pg_advisory_xact_lock` on a key derived from the schema name. A second instance starting at the same moment waits on that lock.
3. Each migration runs inside a `DO` block that checks `schema_migrations` after the lock is held, so a migration is applied exactly once even when several instances start together.

The lock is transaction-scoped rather than the session-scoped `pg_advisory_lock` because transaction poolers and Neon's HTTP driver do not keep a session across transactions.

To add a migration: create the next numbered file, write `{{schema}}.table` for every table (it is replaced with the configured schema), never drop or rewrite data, then run `node providers/storage-postgres/scripts/embed-migrations.mjs`. That embeds the SQL into `src/migrations.generated.ts` so Workers, which have no filesystem, can apply it; a test fails if the two drift apart.

## Cloudflare Workers

Workers cannot open TCP sockets without `nodejs_compat`, so on Workers the provider uses Neon's HTTP driver and `DATABASE_URL` must be a Neon URL. The package's `workerd` and `worker` export conditions point bundlers at an entry without postgres.js, so the Worker bundle contains no Node built-ins. Set the URL as a secret:

```sh
npx wrangler secret put DATABASE_URL
```

Every request is one HTTPS call to Neon; there is no pool to manage. Migrations run on the first request of each isolate (a single quick read once the schema is current).

## Backups

Everything lives in one schema, so a schema dump is a complete backup:

```sh
pg_dump --schema=vid2context --format=custom --file=vid2context.dump "$VID2CONTEXT_DATABASE_URL"
pg_restore --dbname="$TARGET_URL" vid2context.dump
```

The dump has no extensions in it: run `create extension if not exists vector` on the target first. Managed hosts add their own backups on top: Neon keeps history you can restore or branch from, Supabase takes daily backups, and Cloud SQL, Railway and ApsaraDB offer automated backups and point-in-time recovery on their paid plans.

## Errors

| Code | Usual cause | What to do |
|---|---|---|
| `auth` | wrong user or password, or the role lacks a privilege | fix the URL, or grant `CREATE` on the database or schema, or point `VID2CONTEXT_PG_SCHEMA` at a schema the role owns |
| `unavailable` | server unreachable, database missing, TLS mismatch, pgvector missing | check host, port and `sslmode`; enable the `vector` extension |
| `timeout` | connect timeout or statement timeout | check the firewall; raise `VID2CONTEXT_PG_STATEMENT_TIMEOUT_MS` |
| `rate-limited` | the server is out of connections | lower `VID2CONTEXT_PG_POOL_MAX` or use the pooled URL |
| `not-found` | unknown collection id | list collections for valid ids |

## Testing

Unit tests run on PGlite (Postgres compiled to WebAssembly, with the real pgvector extension), offline:

```sh
npx vitest run providers/storage-postgres
```

`LIVE=1` adds tests against `DATABASE_URL` when it is set, or against a throwaway `pgvector/pgvector` container plus Neon's open-source HTTP proxy when Docker is available. They cover the full storage contract on both drivers, concurrent first starts under the advisory lock, the HNSW query plan, and the provider running inside workerd through Miniflare.
