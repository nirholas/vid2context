# 57. Note exports: Obsidian vaults and Notion pages

| | |
|---|---|
| Track | L. Reach (wave 2) |
| You own | `packages/exporters/` (new package `@vid2context/exporters`) |
| Shared edits allowed | your rows in `docs/providers.md` and `.env.example`; your entry in `THIRD_PARTY_NOTICES.md` if you copy code |
| Commit scope | `exporters` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents. People who research seriously keep notes in Obsidian or Notion and want the transcripts there, linked and searchable, next to their own thinking. Exporting a collection (say, a whole G-Wagon buyer's series) as linked notes with timestamp links turns a pile of videos into a knowledge base. No wave-1 prompt covers note apps.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `storage.ts` (`Collection`), `segments.ts` (`timestampUrl`, `formatTimestamp`), `format/index.ts`, `testing.ts`.
3. `docs/contracts/mcp-tools.md` and `http-api.md`, "Wave 2" (`export_obsidian`, `export_notion`, `/exports/*`).
4. Obsidian docs on properties (YAML frontmatter), wikilinks and callouts; Notion API docs (create page, append block children, rich text limits of 2000 characters, 100 blocks per request, rate limits about 3 requests per second, the `Notion-Version` header). Verify current values.
5. `docs/prompts/SHARED-CONTRACTS.md` sections 2 (formatter ids) and 8.

## Goal

`exportObsidian(contexts, collection?)` returns the files of a vault folder (one note per video, one index note per collection), and the Node writer puts them on disk; `exportNotion(contexts, { parentPageId })` creates one Notion page per video under a parent page, with chapters as headings and timestamp links.

## Requirements

### Obsidian

- Runtime-neutral renderer `renderObsidian(contexts, opts) -> { path, content }[]`; Node writer `writeObsidian(files, vaultPath)` in `src/node.ts` (the only file importing `node:fs`), refusing to write outside `vaultPath` (resolve and check every path) and never overwriting a note that has a different `vid2context-id` property unless `overwrite: true`.
- Note per video: frontmatter properties (`title`, `channel`, `url`, `published`, `duration`, `tags`, `transcript_origin`, `language`, `vid2context-id`), a summary callout left out unless a brief exists for it (do not invent one), chapters as `##` headings, paragraphs prefixed with `[m:ss](timestampUrl)`, comments section only when present. Safe filenames (strip characters Obsidian and filesystems reject, keep them readable, dedupe collisions).
- Collection index note: description, sources, a table of videos with `[[wikilinks]]`, durations and channels.

### Notion

- `exportNotion(contexts, { parentPageId, token? }, ctx)` with `NOTION_TOKEN` and `NOTION_PARENT_PAGE_ID` from `ctx.env`: create a page per video (title property, a bookmark block to the video, chapter headings, paragraphs with timestamp links as rich text links), chunking rich text at 2000 characters and children at 100 blocks per request, appending in order. Respect rate limits: pace requests and honour 429 `Retry-After` through `errorFromResponse` codes. Return page URLs. Idempotency: search the parent for an existing page with the same `vid2context-id` (stored in the page as a property or a hidden-first-block convention you document) and update instead of duplicating.

### Surfaces

- `src/mcp.ts`: `registerExporterTools(server, deps)` with `export_obsidian` (only registered when the runtime is Node, since it writes local files) and `export_notion`. `src/http.ts`: `exporterRoutes(deps)` with `POST /exports/notion` and `POST /exports/obsidian` (returns the file list as JSON; never writes server-side).

## Prefer free and local

Obsidian is local files. Notion's API is free with an integration token.

## Out of scope

- Zipping a vault: item 15 can zip the file list. Two-way sync.

## Tests

- Obsidian: render the real shared contexts (`tests/fixtures/contexts/*.json`) and assert frontmatter, headings, links, filenames and the index note; writer tests in a temp directory, including path-escape attempts and the overwrite guard.
- Notion: if `NOTION_TOKEN` is set, run LIVE against a test page and record the real responses (trim ids that matter and document them) for replay tests. If not, test request construction against the real fixtures (chunk sizes, block counts, ordering) and report that Notion is unverified live. Never hand-write a Notion response.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/exporters` prints nothing; `npx vitest run packages/exporters` passes; `npx biome check packages/exporters` is clean.
- [ ] A vault exported from both shared contexts opens cleanly in Obsidian conventions (valid YAML, working wikilinks); paste the index note in your report.

## Docs

- `packages/exporters/README.md`; `NOTION_TOKEN` and `NOTION_PARENT_PAGE_ID` in `.env.example` and `docs/providers.md` (an "Exports" table; your rows only).

## If credentials, tools or network are missing

Without a Notion token, ship Obsidian fully and Notion with tests on request construction only, and report it.

## Repo rules (binding, same as AGENTS.md)

- Never use the em-dash or en-dash characters: not in code, comments, docs, UI copy or commit messages. Use commas, colons, periods or parentheses. No emojis.
- No mocks, fake data, placeholders, TODOs, stub functions or "coming soon" text. If a piece cannot be built for real now, leave it out and say so in your final report.
- Tests use real data only: fixtures recorded from the real service, replayed through `replayFetch` and `testContext` from `@vid2context/core/testing`, or live calls gated by `LIVE=1` (`describe.skipIf(!process.env.LIVE)`). A unit test must never reach the network. Every fixture gets a line in its folder's `README.md` saying where and when it was recorded.
- Core code and providers never read `process.env` or the global `fetch`: use the `ctx` passed to every call. Log through `ctx.log` (stderr). stdout is program output and the MCP stdio channel.
- Prefer plain `fetch` over vendor SDKs. `packages/core` and every provider that declares the `workers` or `browser` runtime must not import Node built-ins.
- Every error a user can see is a `Vid2ContextError` with a stable `code` and a `hint` that says how to recover.
- Free first: local, then free tiers with the user's own key, then keyless hosts, and paid services last, only when their key is set. Every model id is overridable by env. New env vars go into `.env.example` and `docs/providers.md` in the same commit.
- Keep raw transcripts. Cleaned text, summaries, translations and briefs are added layers, never replacements.
- TypeScript, ESM, explicit `.ts` import extensions, Biome formatting (`npx biome check --write <your paths>`).

## Working in a shared folder

You are one of many agents working at the same time in this folder (wave 1 prompts 01 to 50 and wave 2 prompts 51 to 62), each owning different directories.

- Create and edit files only inside the directories this prompt says you own, plus the shared edits listed in its header. Keep shared edits small and additive, and re-read a shared file immediately before every edit: another agent may have changed it a minute ago. `docs/prompts/SHARED-CONTRACTS.md` section 8 lists who may edit which shared file.
- If the foundation code differs from what this prompt describes, the code wins: read it and adapt. If something you need from another prompt has not landed yet, build everything else first and check again before you finish. If it is still missing, leave that piece out and list it in your report. Never stub it.
- Dependencies go only into your own package's `package.json`. Install through the shared lock so parallel installs cannot corrupt `node_modules`: `mkdir -p .vid2context/locks && flock .vid2context/locks/npm npm install -w <your package dir> <name>@<version>`. Never hand-edit `package-lock.json`; if it conflicts, rerun the install through the lock. Never edit `packages/registry/src/generated/`; run `npm run gen` instead.
- Other agents' unfinished work can break the repo-wide `npm run typecheck` and `npm test`. Judge your own paths: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E '<your dirs>'` prints nothing, `npx vitest run <your dirs>` passes, `npx biome check <your dirs>` is clean. Do not fix other agents' files; mention breakage you saw in your report.
- Never run commands that touch other agents' work: `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset`, `git checkout -- <path>`, `git restore`, `git clean`, `git rebase`, `git push`.
- Servers you start for testing: pick a random port between 20000 and 29999, and stop them when you are done.

## Committing

The owner asks you to commit your own work as described here. Commit each coherent piece as soon as it works, not only at the end.

1. `git status --short` and check that every path you will commit is yours.
2. `flock .vid2context/locks/git git add <explicit paths>` (needed for new files).
3. Commit only your paths, which leaves anything other agents staged untouched:
   `flock .vid2context/locks/git git commit -m "<type>(<scope>): <what changed and why it matters>" -m "<body: what and why, in plain language>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <explicit paths>`
   (use the Co-Authored-By trailer your harness specifies if it names a different model).
4. `git show --stat HEAD` and confirm only your files are in the commit.

Types: feat, fix, refactor, perf, test, docs, chore. Never use subjects like "update" or "wip". Do not push. Never amend or rewrite a commit you did not make.

## Final report

Finish with a short report to the owner: what you built (paths), what you verified live and how, what you could not verify and why (missing key, tool or network), every shared-file edit you made, what the integration pass needs to wire up, and any breakage you noticed outside your directories.
