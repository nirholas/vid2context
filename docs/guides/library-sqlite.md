# Local library on SQLite

On Node, vid2context keeps your library in one SQLite file: every saved video context (raw transcript included), collections, full-text search over every segment, small key-value state (watch lists, jobs) and embedding vectors. No server, no account, no dependency: it uses `node:sqlite`, built into Node 22.13 and newer. The data stays on your machine.

The CLI, MCP server and HTTP API use it automatically through `registry.openStorage(ctx)` whenever the provider `@vid2context/provider-storage-sqlite` is installed and no other backend is chosen.

## Where the file lives

| Setting | Path |
|---|---|
| default | `.vid2context/library.db` in the working directory |
| `VID2CONTEXT_HOME=/data/v2c` | `/data/v2c/library.db` |
| `VID2CONTEXT_DB=/srv/library.db` | exactly that file (wins over `VID2CONTEXT_HOME`) |
| `VID2CONTEXT_DB=:memory:` | in memory, gone when the process exits |

The directory is created on first use. Next to the file you may see `library.db-wal` and `library.db-shm` while a process has it open: SQLite runs in WAL mode so readers never block the writer. They are folded back into `library.db` when the last connection closes.

To use another backend set `VID2CONTEXT_STORAGE` (`postgres`, `cloudflare`, or `memory` for no persistence). A configured Postgres wins over SQLite on its own; the order is in [providers.md](../providers.md#library-storage).

## Backups

Copy a consistent snapshot while vid2context is running:

```sh
sqlite3 .vid2context/library.db "VACUUM INTO 'library-backup.db'"
```

Without the `sqlite3` tool, the same works from Node:

```sh
node -e "new (require('node:sqlite').DatabaseSync)('.vid2context/library.db').exec(\"VACUUM INTO 'library-backup.db'\")"
```

`VACUUM INTO` writes a compact copy and fails rather than overwrite an existing file. Copying `library.db` with `cp` is only safe when no process has it open. To restore, stop vid2context and put the backup in place of `library.db` (delete any leftover `-wal` and `-shm` files first).

## Search syntax

Library search (`search_transcript` in the MCP server, `GET /search` in the HTTP API) matches whole words in transcript segments and ranks results with bm25: segments containing more of your words, and rarer words, come first. Case and accents are ignored (`elephants` finds `Éléphants`).

| You type | Finds |
|---|---|
| `reliable engine` | segments with either word; those with both rank first |
| `"land cruiser"` | the exact phrase, words adjacent and in order |
| `reliab*` | words starting with `reliab` (reliable, reliability) |
| `"land cru"*` | a phrase whose last word is a prefix |
| `G-Wagon` | the words `g` and `wagon` next to each other |

Anything else is treated as plain text: `AND`, `OR`, `NOT`, `NEAR`, parentheses, `-word`, `column:` filters and unbalanced quotes are dropped or ignored, so no input causes an error. A word without `*` must match a whole word: `reliab` alone finds nothing.

Results can be limited to a collection or a list of video ids. Each hit has the video id and title, the segment's start and end in seconds, the full segment text and a score between 0 and 1 (higher is better).

## Limits

- Node only. Workers and browsers use other backends (Cloudflare D1, Postgres over HTTP, or in-memory storage).
- One machine. Several processes on the same machine can share the file (writes wait up to `VID2CONTEXT_DB_BUSY_TIMEOUT_MS`, default 5000 ms), but do not put it on a network share: SQLite locking is unreliable there. Use Postgres for a shared library.
- Search is per segment. A phrase split across two caption segments is not found as a phrase; search the words without quotes instead.
- If Node's bundled SQLite ever lacks FTS5, search falls back to substring matching with simpler scores and logs one warning. Everything else works the same, and the index is rebuilt when FTS5 is available again.
- Vector search is exact cosine similarity computed in JavaScript, which is fast up to tens of thousands of chunks per model. A later version may add the `sqlite-vec` extension for larger libraries; it is not used today.
- Schema changes are applied automatically on open and never drop data. A library written by a newer vid2context refuses to open in an older one, with a hint to upgrade.
