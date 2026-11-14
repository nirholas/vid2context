# @vid2context/exporters

Turns video contexts into notes you keep: an Obsidian vault folder (one note per video, one index note per collection) or Notion pages (one per video, under a parent page). Transcripts stay whole; chapters become headings and every paragraph starts with a link that opens the video at that moment.

| Entry | Runtime | What |
|---|---|---|
| `@vid2context/exporters` | any | `renderObsidian`, `exportObsidian`, `exportNotion`, `planNotionPage`, helpers |
| `@vid2context/exporters/node` | Node | `writeObsidian(files, vaultPath, { overwrite? })` |
| `@vid2context/exporters/http` | any | `exporterRoutes(deps)`: `POST /exports/obsidian`, `POST /exports/notion` |
| `@vid2context/exporters/mcp` | any | `registerExporterTools(server, deps)`: `export_obsidian` (stdio on Node only), `export_notion` |

## Obsidian

```ts
import { exportObsidian } from '@vid2context/exporters';
import { writeObsidian } from '@vid2context/exporters/node';

const files = exportObsidian(contexts, collection); // [{ path, content }], nothing written yet
await writeObsidian(files, '/home/me/Vault');
```

Each video note has:

- Properties (YAML frontmatter): `title`, `channel`, `url`, `published` (a date, when known), `duration`, `tags`, `transcript_origin`, `language`, `translated` (only when true), `collection` (a link to the index note) and `vid2context-id`.
- A summary callout only when you pass a brief for that video (`briefs: { 'youtube:<id>': markdown }`). None is ever generated here.
- The description in a folded callout, chapters as `##` headings (or one `## Transcript`), paragraphs of about 30 to 45 seconds prefixed with `[m:ss](timestamp link)`, and a `## Comments` section only when comments were fetched.

The collection index note has the description, the sources, a table of videos with `[[wikilinks]]`, channels, durations and transcript origins, and a list of collection videos that had no saved context.

Filenames stay readable but safe on every filesystem and in links: `:` becomes ` - `, `/ \ |` become `-`, `"` becomes `'`, `# ^ [ ] * ? < >` and control characters are dropped, names are capped at 180 bytes, Windows device names get a `_`, and collisions get ` (2)`, compared case-insensitively. The folder defaults to the collection name, or `vid2context`; pass `folder` to choose another.

Text that would turn into Obsidian syntax (`#tags`, `$math$`, `==highlights==`, `[[links]]`, `%%comments%%`, table pipes) is escaped, so a price like `$85,000` stays text. Bare URLs are left as they are.

`writeObsidian` refuses absolute paths, `..`, hidden folders such as `.obsidian/`, non-`.md` files and symlinks that lead outside the vault. It replaces an existing note only when that note's `vid2context-id` matches the new one, so re-exporting updates your earlier exports and never touches your own notes, unless you pass `overwrite: true`. All checks run before the first write: a refused export writes nothing.

## Notion

```ts
import { exportNotion } from '@vid2context/exporters';
const pages = await exportNotion(contexts, { parentPageId: 'https://www.notion.so/...' }, ctx);
// [{ videoId, pageId, url, status: 'created' | 'updated' | 'unchanged' }]
```

Setup: create an internal integration at https://www.notion.so/profile/integrations, copy its secret into `NOTION_TOKEN`, then open the parent page in Notion and add the integration under the page menu, Connections. Set `NOTION_PARENT_PAGE_ID` to the page link or id, or pass `parentPageId` per call. The API is free with an integration token.

Each page has a gray marker paragraph, the facts (channel, duration, published date, transcript origin), a bookmark to the video, a summary callout when a brief exists, the description in a toggle, a `heading_2` per chapter starting with its timestamp link, transcript paragraphs whose first word is a timestamp link, and the comments as a bulleted list.

How the API limits are handled (values checked on 2026-11-14 against developers.notion.com):

| Limit | Handling |
|---|---|
| `Notion-Version` | `2026-03-11` |
| 2000 characters per rich text item and per link URL | text is split at whitespace into several items; longer links are dropped |
| 100 blocks per `children` array, 100 rich text items per block | the page is created with the first 100 blocks, the rest appended in order, 100 at a time |
| 1000 block elements and 500 KB per request | batches also close on element count and on a 400 KB budget |
| about 3 requests per second | requests are spaced 350 ms apart; 429 and 529 answers wait for `Retry-After` (or back off) and retry up to 5 times |

Idempotency: pages under a page only have a title property, so the first block of every exported page is a gray paragraph:

```
vid2context-id: youtube:cCPsdFdlshc
vid2context-digest: 7a5c2cd11605b19c
```

An export lists the parent's child pages, reads each one's first block (once per export) and, when one carries the same id, updates that page instead of creating another: it renames it, clears its content (`erase_content`) and appends the new blocks. The digest is a SHA-256 of the planned title and blocks; a page whose digest matches is left alone and reported as `unchanged`. While a write that needs several requests is in progress, the marker reads `vid2context-digest: incomplete`, so an interrupted export is rewritten on the next run. Keep the marker as the first block if you edit an exported page; anything you add to the page is replaced on the next changed export.

## HTTP and MCP

- `POST /api/v1/exports/obsidian` with `{ inputs?, collectionId?, folder? }` returns `{ files: [{ path, content }], missing }`. The server never writes files: the caller does, or the bundle route zips them.
- `POST /api/v1/exports/notion` with `{ inputs?, collectionId?, parentPageId? }` returns `{ pages: [{ videoId, url, pageId, status }], missing }`.
- MCP `export_obsidian` `{ urls?, collection?, vaultPath, folder?, overwrite? }` writes on the machine running the server, so it is for the stdio server only. It is registered when the runtime is Node, unless the server passes `localFiles: false` (a remote server should, so the tool is not listed). A call that arrives over an HTTP transport is refused with a hint pointing at stdio or `POST /exports/obsidian`, even when the tool is listed. `export_notion` `{ urls?, collection?, parentPageId? }` is registered everywhere.

`inputs` and `urls` can be videos, playlists, channels or feeds (expanded through the registry); `collection` and `collectionId` need a storage backend. Both can be combined; videos are exported once each.

## Tests

`npx vitest run packages/exporters` renders the shared real contexts in `tests/fixtures/contexts/`, parses the frontmatter with a YAML parser, checks headings, links, filenames and the index note, renders real recorded YouTube comments (`test/fixtures/`, see its README) in both formats, and runs the writer in a temporary folder with path-escape attempts and the overwrite guard. Notion tests check request construction (block order, chunk sizes, batch counts, limits) without any Notion response, because no token was available when this package was written. `notion.live.test.ts` runs against the real API with `LIVE=1`, `NOTION_TOKEN` and `NOTION_PARENT_PAGE_ID` (use a scratch page: it creates pages there).
