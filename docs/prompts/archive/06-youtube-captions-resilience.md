# 06. YouTube: player clients, caption formats and IP-block resilience

| | |
|---|---|
| Track | B. YouTube |
| You own | `providers/youtube/src/captions/` and `providers/youtube/src/resilience/` (new), plus today's `providers/youtube/src/innertube.ts`, `captions.ts` and `timedtext.ts` (you may move them into those folders) |
| Shared edits allowed | `providers/youtube/src/index.ts` (captions provider wiring and re-exports only); your own `## Captions and blocks` section in `docs/guides/youtube.md`; your rows in `docs/providers.md` and `.env.example` |
| Commit scope | `youtube` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. YouTube is the main source, and captions are the cheapest, most accurate path: no audio download, no speech-to-text. Today the provider uses one innertube client (ANDROID, verified working from the GCP VM on 2026-11-14) and srv3/srv1 caption XML. One client change at YouTube, or a datacenter IP flagged as a bot, and captions stop. This prompt makes captions robust: several player clients with ordered fallback, every caption format, translated tracks, a precise error taxonomy, backoff, a circuit breaker after blocks, and optional cookies and PO tokens, with errors that tell the user exactly what to do. It absorbs roadmap item 10 (resilience).

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (the note on YouTube blocking datacenter IPs).
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts` (`CaptionsProvider`, `CaptionOptions`), `packages/core/src/errors.ts` (`blocked`, `unavailable`, `not-found`, `rate-limited`), `packages/core/src/testing.ts`.
3. All of `providers/youtube/src/` (`innertube.ts`: `fetchPlayer`, `getPlayer`, `playabilityError`, `youtubeHttpError`, `BLOCKED_HINT`; `captions.ts`: `chooseTrack`, `spokenLanguage`, `fetchTrack`; `timedtext.ts`: `parseSrv3`, `parseSrv1`; `index.ts`) and its tests and fixtures (`providers/youtube/test/fixtures/README.md`, including the real 429 block page).
4. `docs/contracts/providers.md` and `docs/providers.md`.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7 and 8.

## Goal

`youtube-captions` returns the right track for any requested language whenever any client can reach it, falls back across clients automatically, parses every caption format YouTube serves, and turns every failure into a stable error code with an actionable hint, while repeated requests after a block fail fast instead of hammering YouTube.

## Requirements

### Coordinate with neighbours

- Prompt 07 owns `metadata.ts` and `providers/youtube/src/metadata/`, prompt 08 owns `url.ts` and `providers/youtube/src/browse/`, prompt 09 owns `providers/youtube/src/comments/`. They import your exports (`getPlayer` today). Keep every name currently exported from `providers/youtube/src/index.ts` stable; if you move files, keep the old export names re-exported from `index.ts`. Expose a generic `innertubeRequest(endpoint, body, client, ctx)` helper so 07, 08 and 09 can call `next`, `browse` and `search` without duplicating transport code (they will check for it).

### Player clients

- A single table of clients (`clientName`, `clientVersion`, platform extras such as `androidSdkVersion`, `deviceModel`, user agent) in `src/resilience/clients.ts`, ordered: ANDROID first (works today), then IOS, TVHTML5_SIMPLY_EMBEDDED_PLAYER, WEB, MWEB. Verify each live before including it; drop any that no longer returns captions and record why in the docs. Allow overriding the order with `YOUTUBE_CLIENTS=android,ios,...` and versions with `YOUTUBE_<CLIENT>_VERSION`.
- Switch to the next client on `LOGIN_REQUIRED` for client reasons, `UNPLAYABLE` with a client-specific reason, missing `captions` when the video is known to have them, or HTTP errors other than a block. Record each client tried as an attempt detail.
- Cache the player response per video id per process for a short time (60 s) so metadata and captions calls in one request share it.

### Caption formats and choice

- Parsers: srv3 and srv1 (exist), plus json3 (`&fmt=json3`, events with `tStartMs`, `dDurationMs`, `segs`) and WebVTT (`&fmt=vtt`). Prefer srv3; note in code that `&fmt=json3` was ignored by the endpoint in a live test on 2026-11-14, so detect the returned format from the body, not the request.
- Translated tracks through `tlang=<lang>` when the requested language has no native track and a track is `isTranslatable`; mark the transcript `translated: true` and keep the source language in `extra` if useful.
- Track choice, exactly: if a language is requested: a creator track in that language, then an asr track in that language, then a translation (if `allowTranslated` is not false). Otherwise: a creator track in the spoken language (an asr track's language reveals the spoken language), then any creator track (the default index first), then asr. Respect `allowAuto: false`.

### Error taxonomy

- Map playability status and reasons to codes with hints:
  - `not-found`: removed, private, invalid id.
  - `unavailable`: age-restricted, members-only, region-blocked, live stream not ended, upcoming premiere (include the scheduled time when present).
  - `blocked`: "Sign in to confirm you're not a bot", the 429 HTML page (the committed fixture), or consistent 403s on timedtext. Hint: run vid2context locally or behind the Cloudflare Tunnel guide (`docs/guides/cloudflare-tunnel.md`, prompt 45), set `YOUTUBE_COOKIE`, or install the yt-dlp provider (prompt 11).
  - `rate-limited`: 429 with Retry-After from the API (not the block page).

### Resilience

- Exponential backoff with full jitter on 429 and 5xx (max 3 retries, honour Retry-After), never on `blocked`.
- A per-process circuit breaker in `src/resilience/breaker.ts`: after a `blocked` result, further YouTube calls fail fast for 10 minutes (`YOUTUBE_BLOCK_COOLDOWN_SEC`) with the same error and hint, plus an attempt reason `circuit-open`.
- Optional credentials, all through `ctx.env`: `YOUTUBE_COOKIE` (a raw Cookie header value), `YOUTUBE_PO_TOKEN` and `YOUTUBE_VISITOR_DATA` passed in the request context where the client supports them. Reading a Netscape cookies file is Node-only; this provider runs on Workers and in the browser, so document that the surface (CLI or server) reads `YOUTUBE_COOKIES_FILE` into `YOUTUBE_COOKIE`, and leave that to them.
- Proxies: do not add proxy code. Document Node 24's built-in support (`NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY`) instead.
- Never log cookie or token values.

## Prefer free and local

Everything here is keyless. Running locally on a residential IP is the most reliable path, and the hints say so. Cookies are optional and personal; the docs must warn that they tie requests to the user's account.

## Prior art you may reuse

`youtubei.js` (LuanRT/YouTube.js, MIT, runs on Node, Workers and browsers) is a maintained innertube client with player clients, caption tracks and session handling; `bgutils-js` (LuanRT/BgUtils, MIT) generates PO tokens; `yt-dlp/ejs` (Unlicense) solves signatures and the n parameter in JS. jdepoix/youtube-transcript-api (MIT, Python) has a well-tested error taxonomy (`_errors.py`: IpBlocked, RequestBlocked, AgeRestricted, ...) and proxy and cookie options worth porting. Decide whether to depend on youtubei.js or keep the own client and port its logic; say which in your report and why. Licenses and attribution rules: `docs/prior-art.md`. Copy only MIT, BSD, ISC, Unlicense or Apache-2.0 code, keep the original copyright line in the copied file, and add the project to `THIRD_PARTY_NOTICES.md` (create it if missing; additive edits only). Never copy GPL or unlicensed code.

## Out of scope

- Metadata, chapters, video states as metadata: prompt 07.
- Playlists, channels, search and URL matching: prompt 08.
- Comments: prompt 09.
- Audio download and the yt-dlp fallback: prompt 11.

## Tests

- Record new real fixtures into `providers/youtube/test/fixtures/` (document each in its `README.md`; strip stream URLs that embed your IP): player responses from each client you keep for `jNQXAC9IVRw`; a json3 and a vtt caption payload; a translated track (`tlang`); and one real example of each error class, found from real public videos: age-restricted, members-only, removed, private, an upcoming premiere. If an example cannot be found or reached, say so in the report rather than inventing one.
- Unit tests with `replayFetch`: client fallback order (first client returns LOGIN_REQUIRED from a real recording, second succeeds), each parser on its real payload, the track choice rules on real track lists, each error class mapping, backoff timing (with fake timers over real responses), and the circuit breaker opening on the real 429 block page and closing after the cooldown.
- LIVE tests (`describe.skipIf(!process.env.LIVE)`): captions for `jNQXAC9IVRw` in `en` and `de`, a translated track, and one error class.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/youtube'` prints nothing.
- [ ] `npx vitest run providers/youtube` passes (including the existing tests).
- [ ] `npx biome check providers/youtube` is clean.
- [ ] `npm run cli -- https://www.youtube.com/watch?v=jNQXAC9IVRw --lang de` returns German creator captions live; `--lang fr` returns a translated track marked translated.
- [ ] Every export that `providers/youtube/src/index.ts` had before your change still exists.

## Docs

- Write the `## Captions and blocks` section of `docs/guides/youtube.md` (create the file if missing; re-read before editing, prompts 07, 08 and 09 add their own sections): how tracks are chosen, clients and fallback, what a block looks like, and every fix.
- Add your env vars (`YOUTUBE_CLIENTS`, `YOUTUBE_COOKIE`, `YOUTUBE_PO_TOKEN`, `YOUTUBE_VISITOR_DATA`, `YOUTUBE_BLOCK_COOLDOWN_SEC`) to `.env.example` and `docs/providers.md`.

## If credentials, tools or network are missing

No key is needed. If YouTube blocks this machine during your work, that is itself a test: record the real block responses, verify the breaker and hints, and report which live checks could not run.

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
