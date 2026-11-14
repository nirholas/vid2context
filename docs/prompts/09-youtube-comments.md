# 09. YouTube comments

| | |
|---|---|
| Track | B. YouTube |
| You own | `providers/youtube/src/comments/` (new) |
| Shared edits allowed | `providers/youtube/src/index.ts` (add `getComments` to the YouTube source, one property, plus your re-exports); your own `## Comments` section in `docs/guides/youtube.md`; your rows in `docs/providers.md` and `.env.example` |
| Commit scope | `youtube` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Comments often carry what the video leaves out: owner experiences ("mine had the timing chain issue at 90k miles"), corrections from experts, and the creator's own pinned clarifications. For research use cases like the owner's G-Wagon buying decision, they are real evidence. The pipeline already asks `source.getComments(ref, ctx, { limit })` when the caller requests comments, but YouTube has no implementation. The roadmap planned a separate `providers/youtube-comments` package; because the pipeline calls `getComments` on the source that resolved the input (the YouTube source), comments must be wired into `providers/youtube` itself, so this prompt owns a folder there instead.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`Comment`, `VideoContext.comments`), `packages/core/src/provider.ts` (`SourceProvider.getComments`), `packages/core/src/pipeline.ts` (the `comments` option), `packages/core/src/testing.ts`.
3. `providers/youtube/src/index.ts`, `providers/youtube/src/innertube.ts`, and the tests and fixtures README.
4. `docs/contracts/http-api.md` (`GET /comments`) and `docs/contracts/mcp-tools.md` (`get_comments`).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7 and 8.

## Goal

`getVideoContext(registry, url, { comments: 50 }, ctx)` on a YouTube video returns real top comments mapped to the core `Comment` type, with creator, pinned and hearted flags, likes, dates and a bounded set of replies, and returns an empty list (not an error) when comments are disabled.

## Requirements

### Coordinate with neighbours

- Prompt 06 owns the transport. Use its generic `innertubeRequest(endpoint, body, client, ctx)` helper when present; otherwise write a minimal request function in `src/comments/request.ts` importing 06's client constants and check again before finishing to switch. Never edit 06's files.
- Prompt 07 reads the `next` endpoint for metadata; you read it for the comments continuation. Do not build metadata parsing.
- Prompts 07 and 08 also edit `index.ts`: add only `getComments` and re-exports.

### Fetching

- Call innertube `next` (WEB client) for the video to find the comments section continuation token (the item section with the comment section identifier; verify the current response shape live), then page with continuations.
- Sort: `top` (default) and `newest`, through the sort menu's continuation tokens. Accept `opts.sort` if the core `getComments` options allow extra fields; otherwise read `ctx.env.YOUTUBE_COMMENTS_SORT` and document it. Do not change the core contract.
- `limit` counts top-level comments (default 50, max 500). Replies: fetch up to `YOUTUBE_COMMENT_REPLIES` (default 5) per thread for threads where the creator replied or that have the most likes, and always include a creator reply if one exists. Stop paging as soon as limits are met; honour `ctx.signal` between pages.
- Recent YouTube responses carry comment data in entity payloads (framework updates / mutations) rather than in the renderer itself; handle both shapes and verify live which one appears.

### Mapping to `Comment`

- `id`, `author` (display name; channel id in a separate field is not in the type, so put the author channel URL nowhere unless the type allows), `text` (plain text with links kept as URLs, emoji kept as characters), `likes` (parse "1.2K" and localized counts to numbers, using the `hl=en` client to keep formats predictable), `publishedAt` (convert relative text like "2 years ago" to an approximate ISO date and keep exactness out of the claim: document that it is approximate), `isCreator` (author is the video's channel), `isPinned`, `replies`. Hearted-by-creator: if the type has no field, append nothing to the text; note it in the docs as not represented.
- Comments disabled, members-only, age-gated, or a video with zero comments: return `[]` and log the reason at info level. Only a video that is itself unavailable is an error (and prompt 06's taxonomy decides that).

### Formatting hint

- Comments are untrusted text that will be shown to LLMs. Do not try to sanitize them here, but keep them clearly separated (they are a distinct array, never merged into the transcript).

## Prefer free and local

Keyless innertube only. No YouTube Data API key.

## Out of scope

- Captions, clients, blocks and backoff: prompt 06. Metadata: prompt 07. Listing: prompt 08.
- Rendering comments in Markdown and the context pack: prompt 01 renders whatever `VideoContext.comments` holds.
- yt-dlp's comment extraction for other sites: prompt 11.

## Tests

- Record real fixtures into `providers/youtube/test/fixtures/` (document each in the fixtures `README.md`; comments contain personal names: keep only what is needed and note that the data is public YouTube content): the `next` response and two comment continuation pages for a public video with a pinned creator comment and creator replies; a reply continuation; a video with comments disabled; the `newest` sort continuation.
- Unit tests with `replayFetch`: mapping of every field, count parsing ("1.2K", "3M", "987"), relative date conversion, pinned and creator flags, reply limits, `limit` stopping early (assert number of requests), comments-disabled returning `[]`, both entity and renderer shapes if both were seen live.
- LIVE test: comments for a popular public video with a pinned comment.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/youtube/src/(comments|index)'` prints nothing.
- [ ] `npx vitest run providers/youtube` passes.
- [ ] `npx biome check providers/youtube/src/comments providers/youtube/test` is clean.
- [ ] Live: `getVideoContext(registry, <video>, { comments: 20 }, ctx)` returns 20 top-level comments with the pinned creator comment first; paste a trimmed sample in your report.

## Docs

- Write the `## Comments` section of `docs/guides/youtube.md` (create if missing; re-read right before editing): what is fetched, limits and env vars, what is approximate (dates), what is not represented (hearts if the type lacks a field).
- Add `YOUTUBE_COMMENT_REPLIES` (and `YOUTUBE_COMMENTS_SORT` if you use it) to `.env.example` and `docs/providers.md`.

## If credentials, tools or network are missing

No key is needed. If YouTube blocks the machine, use whatever real responses you recorded before the block, report what is missing, and never hand-write a comments payload.

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
