# 07. YouTube: metadata, chapters and video states

| | |
|---|---|
| Track | B. YouTube |
| You own | `providers/youtube/src/metadata/` (new) and today's `providers/youtube/src/metadata.ts` (you may move it into the folder) |
| Shared edits allowed | `providers/youtube/src/index.ts` (the `getMetadata` wiring and your re-exports only); your own `## Metadata and chapters` section in `docs/guides/youtube.md` |
| Commit scope | `youtube` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Chapters are how agents navigate long videos (outline first, then fetch one section), and metadata is how they cite and judge sources (who said it, when, how popular, is it a Short or a live stream). Today the provider reads `videoDetails` from the player response and parses chapters from the description only. This prompt makes YouTube metadata complete: publish dates, counts, channel handle, the right thumbnail, video states (Short, live, upcoming premiere, age-gated, members-only), and chapters from every source YouTube exposes, merged with a clear precedence.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`VideoMetadata`, `Chapter`, `extra`), `packages/core/src/provider.ts` (`SourceProvider.getMetadata`), `packages/core/src/testing.ts`.
3. `providers/youtube/src/metadata.ts` (`parseClock`, `parseDescriptionChapters`, `toMetadata`), `providers/youtube/src/innertube.ts` (`getPlayer`, `PlayerResponse`), `providers/youtube/src/index.ts`, and `providers/youtube/test/` with its fixtures README.
4. `docs/contracts/providers.md`, `docs/contracts/http-api.md` (`GET /metadata`, `GET /outline`).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7 and 8.

## Goal

`youtube.getMetadata` returns a rich, accurate `VideoMetadata` for every kind of YouTube video, with chapters from creator timestamps, the player's chapter markers or auto "key moments", every chapter carrying an `endSec`, and `extra.chapterSource` saying where they came from.

## Requirements

### Coordinate with neighbours

- Prompt 06 owns `innertube.ts`, `captions.ts`, `timedtext.ts` and the transport. Call the exported `getPlayer` and, when present, the generic `innertubeRequest(endpoint, body, client, ctx)` helper 06 adds; never edit 06's files. If `innertubeRequest` is not there yet when you need the `next` endpoint, write a minimal request function in your own folder (`src/metadata/next.ts`) using the same client constants by import, and check again before finishing: switch to 06's helper if it has landed.
- Prompts 08 and 09 also edit `index.ts`; touch only the `getMetadata` property and your re-exports.

### Fields

- From the player response: title, author, channelId, lengthSeconds, shortDescription (full), keywords, isLiveContent, best thumbnail (largest available, prefer `maxresdefault`), `isUpcoming`, scheduled start time for premieres.
- From the `next` endpoint (WEB client) or the player microformat when available: publish date and upload date (ISO 8601), view count (number), like count where exposed, category, channel handle (`@name`) and channel URL, subscriber count text when shown. Put numeric counts in `extra.viewCount`, `extra.likeCount`; put the category in `extra.category`.
- `channel: { name, id, url }` always filled when known.
- `language`: the spoken language when the caption track list reveals it (asr language), else `undefined` (do not guess from the title).
- States in `extra`: `isShort` (from the `/shorts/` URL form or `next` response signals; document which signals you rely on and verify them live), `isLive`, `isUpcoming`, `premiereAt`, `ageRestricted`, `membersOnly`. Do not throw for these states here: prompt 06's error taxonomy handles transcript failures; metadata should succeed whenever YouTube returns `videoDetails`.
- `extra.links`: URLs found in the description, de-duplicated, in order.

### Chapters

- Three sources, merged with this precedence: (1) creator chapters from the description, (2) chapter markers from the `next` response (`macroMarkersListRenderer` / `multiMarkersPlayerBarRenderer` chapter markers), (3) auto-generated key moments. Use the first source that yields a valid list.
- Harden `parseDescriptionChapters`: YouTube's own rules (first timestamp is `0:00`, at least 3 entries, ascending, each at least 10 seconds long); accept `h:mm:ss`, `mm:ss`, and titles before or after the timestamp, with separators like `-`, `|`, `:`; ignore timestamps embedded mid-sentence (for example "at 3:45 he says"); trim titles.
- Fill `endSec` with the next chapter's start, and the last with `durationSec`.
- `extra.chapterSource`: `'description' | 'markers' | 'key-moments'`.

### Performance

- One player request per call (shared with captions via 06's short cache when it exists) plus at most one `next` request. If the `next` request fails, return the player-derived metadata and record the failure in a log line, not an error.

## Prefer free and local

All of this is keyless innertube. No key, no paid service.

## Out of scope

- Caption track choice, clients, blocks and backoff: prompt 06.
- Playlists, channels, search, URL forms: prompt 08.
- Comments: prompt 09 (it also reads the `next` endpoint; do not build comment parsing).
- Auto-generating chapters with an LLM for videos that have none: prompt 35.

## Tests

- Record real fixtures into `providers/youtube/test/fixtures/` (document each in the fixtures `README.md`; remove stream URLs that embed your IP): `next` and player responses for (a) a video with creator chapters in the description, (b) a video with chapter markers but no description timestamps if you can find one, (c) a video with auto key moments, (d) a Short, (e) a live stream or a past live stream, (f) an upcoming premiere. Find real public videos for each; if one class cannot be found, report it.
- Unit tests with `replayFetch` over those recordings: every field, every state flag, chapter precedence, `endSec` filling, link extraction.
- Description chapter parser tests on real descriptions taken from the recordings and from `tests/fixtures/contexts/youtube-jNQXAC9IVRw.json` (3 description chapters), plus real descriptions that contain stray timestamps that must not become chapters.
- LIVE tests: metadata for `jNQXAC9IVRw` and one chaptered video.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/youtube/src/(metadata|index)'` prints nothing.
- [ ] `npx vitest run providers/youtube` passes.
- [ ] `npx biome check providers/youtube/src/metadata providers/youtube/src/metadata.ts providers/youtube/test` is clean.
- [ ] Live: `npm run cli -- <a chaptered video URL> --format json` shows chapters with `endSec` and `extra.chapterSource`; paste the chapter list in your report.

## Docs

- Write the `## Metadata and chapters` section of `docs/guides/youtube.md` (create the file if it does not exist; re-read right before editing, prompts 06, 08 and 09 write their own sections): every field, where it comes from, chapter precedence and rules.

## If credentials, tools or network are missing

No key is needed. If YouTube blocks the machine, record the block responses for prompt 06's benefit (in your own fixtures folder section of the README), use already committed real player fixtures for what you can, and report which classes could not be recorded.

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
