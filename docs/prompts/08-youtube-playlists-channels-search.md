# 08. YouTube: playlists, channels and search

| | |
|---|---|
| Track | B. YouTube |
| You own | `providers/youtube/src/browse/` (new) and `providers/youtube/src/url.ts` |
| Shared edits allowed | `providers/youtube/src/index.ts` (the `listItems` wiring and your re-exports only); your own `## Playlists, channels and search` section in `docs/guides/youtube.md` |
| Commit scope | `youtube` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The owner's motivating case is a whole YouTube series (a playlist explaining which Mercedes G-Wagon to buy) absorbed by an agent, and watch lists that follow a channel for new uploads. Both start with expanding a playlist or channel into video refs. Today the provider matches single videos and turns playlist-only URLs into a playlist ref, but cannot list anything. This prompt adds channel and search inputs and implements `listItems` through innertube `browse` and `search` with continuations. The MCP tool `list_items` and the HTTP route `/items` (prompts 44 and 46) and collections (prompt 41) all use it.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`VideoRef`, `RefKind`), `packages/core/src/provider.ts` (`SourceProvider.match`, `listItems`), `packages/core/src/pipeline.ts` (`expandInput`), `packages/core/src/testing.ts`.
3. `providers/youtube/src/url.ts` (`matchYouTube`, `videoRef`), `providers/youtube/src/innertube.ts`, `providers/youtube/src/index.ts`, and the existing tests.
4. `docs/contracts/http-api.md` (`GET /items`) and `docs/contracts/mcp-tools.md` (`list_items`).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7 and 8.

## Goal

`matchYouTube` recognizes every playlist, channel and search input form, synchronously and without network; `listItems` expands them into video refs through innertube with continuation paging, a `limit`, de-duplication and a stable order.

## Requirements

### Coordinate with neighbours

- Prompt 06 owns the transport (`innertube.ts`). Use its generic `innertubeRequest(endpoint, body, client, ctx)` helper when present; otherwise write a minimal request function in `src/browse/request.ts` importing 06's client constants, and check again before finishing to switch to 06's helper. Never edit 06's files.
- Prompts 07 and 09 also edit `index.ts`; touch only `listItems` and your re-exports. Keep `matchYouTube`'s current behaviour for video URLs exactly (the existing tests must pass unchanged).

### Input forms (`url.ts`, synchronous, no network)

- Channels: `youtube.com/@handle`, `/channel/UC...`, `/c/name`, `/user/name`, each optionally followed by a tab: `/videos`, `/shorts`, `/streams`, `/playlists`, `/featured`. Ref kind `channel`, `nativeId` the channel id when known (UC...), otherwise `@handle`, `c:name` or `user:name`, with the tab recorded (for example in the ref id: `youtube:channel:@handle/videos`). Document the id format.
- Playlists: `list=` in any watch URL or `/playlist?list=`, ids with prefixes `PL`, `UU`, `FL`, `OL` (albums); `RD...` mixes are personalized and endless: reject them with `unsupported-input` and a hint. A watch URL with both `v=` and `list=` stays a video ref (current behaviour); document that the playlist form must be passed explicitly.
- Search: an explicit input form `ytsearch:<query>` (and `ytsearch<N>:<query>` for a count), kind `playlist` or a dedicated kind if the core `RefKind` allows; do not add a new `RefKind` value (that is a core contract change). Document the form.
- Never let these forms shadow other providers: only youtube.com, m.youtube.com, music.youtube.com, youtu.be hosts and the `ytsearch:` prefix match.

### `listItems`

- Playlists: `browse` with `browseId: 'VL' + playlistId`, then continuation tokens until the end or `limit`. Playlist order.
- Channels: resolve a handle or legacy name to a channel id (`navigation/resolve_url` or the `browse` response for the handle URL; verify live which works today), then list the requested tab via `browse` with the tab's params, newest first. For the default `videos` tab, try the uploads playlist shortcut first (`UC...` to `UU...`) and fall back to the tab if the playlist is missing.
- Search: the `search` endpoint, videos only (use the filter params for type video; verify live), continuation paging, `limit` default 20, max 200.
- Each item becomes a video ref through the existing `videoRef(input, id)` helper, so ids match single-video refs exactly. De-duplicate by video id. Skip unavailable items ("[Private video]", "[Deleted video]") and count them in a log line.
- Respect `ctx.signal` between pages, and stop paging as soon as `limit` is reached.
- Errors: a private or deleted playlist and a channel that does not exist map to `not-found`; region-blocked to `unavailable`; blocks follow prompt 06's `blocked` error when its helper is used (otherwise map the 429 block page the same way, using `BLOCKED_HINT`).
- `getMetadata` for a playlist or channel ref (title, channel, description, item count when shown) is useful to surfaces: implement it if the `browse` response has it, returning a `VideoMetadata` with `extra.kind`.

## Prefer free and local

Keyless innertube only. No YouTube Data API key is needed or used.

## Out of scope

- Captions, clients, blocks: prompt 06. Video metadata and chapters: prompt 07. Comments: prompt 09.
- Collections and watch lists that store and refresh these lists: prompt 41.
- yt-dlp's playlist support for other sites: prompt 11.

## Tests

- Record real fixtures into `providers/youtube/test/fixtures/` (document them in the fixtures `README.md`): a playlist `browse` response and at least one continuation page; a channel resolved from a handle and its videos tab; a search response with a continuation; a private or deleted playlist error.
- Unit tests with `replayFetch`: every URL form in a table (including inputs that must not match), continuation paging, `limit`, de-duplication, skipped private items, the UU shortcut and its fallback, errors.
- LIVE tests: a real public playlist of at least 3 videos (for example the G-Wagon series playlist if public, otherwise any public playlist; document which), a channel by handle, and a search.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/youtube/src/(browse|url|index)'` prints nothing.
- [ ] `npx vitest run providers/youtube` passes, including every existing URL test unchanged.
- [ ] `npx biome check providers/youtube/src/browse providers/youtube/src/url.ts providers/youtube/test` is clean.
- [ ] Live: `expandInput(registry, '<public playlist URL>', ctx, { limit: 10 })` returns the playlist's videos in order; a `ytsearch5:` query returns 5 video refs. Paste both in your report.

## Docs

- Write the `## Playlists, channels and search` section of `docs/guides/youtube.md` (create if missing; re-read right before editing): every input form, ref id formats, limits, and what is skipped.

## If credentials, tools or network are missing

No key is needed. If YouTube blocks the machine, use the recordings you managed to capture, report what could not be recorded, and never construct a browse response by hand.

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

You are one of 50 agents working at the same time in this folder, each owning different directories.

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
