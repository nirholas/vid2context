# 61. Live streams: transcribe a stream while it is still running

| | |
|---|---|
| Track | N. Sources (wave 2) |
| You own | `packages/live/` (new package `@vid2context/live`) |
| Shared edits allowed | your rows in `docs/providers.md` and `.env.example`; your entry in `THIRD_PARTY_NOTICES.md` if you copy code |
| Commit scope | `live` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents. Today a live stream can only be processed after it ends and a replay exists. Launches, earnings calls, conference keynotes and live Q&As matter most while they happen: an agent should be able to follow one and answer "what has been said about pricing so far?" No wave-1 prompt handles streams in progress (06 and 07 only report live state).

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `pipeline.ts` (`transcribe`), `chain.ts`, `provider.ts` (`SttRung.maxBytes`), `testing.ts`.
3. `providers/youtube/src/innertube.ts` (the ANDROID player response carries `streamingData.hlsManifestUrl` for live videos; verify live), `providers/stt-openai-compatible`.
4. `docs/contracts/mcp-tools.md` and `http-api.md`, "Wave 2" (`watch_live`, `GET /live`).
5. HLS (RFC 8216) playlists: master and media playlists, `EXT-X-MEDIA-SEQUENCE`, `EXT-X-TARGETDURATION`, `EXT-X-ENDLIST`.
6. `docs/prompts/SHARED-CONTRACTS.md` section 8; `docs/prompts/12-media-files-ffmpeg.md` (if `@vid2context/ffmpeg` exists, use it for remuxing; otherwise write a minimal spawn wrapper in your package and note it for the integration pass).

## Goal

`watchLive(url, opts, deps)` yields transcript segments with absolute stream timestamps, about every 30 seconds, for as long as the stream runs or until `maxMinutes` or cancellation, and finishes with the full transcript when the stream ends.

## Requirements

- Resolve the live HLS URL: YouTube through the player response's `hlsManifestUrl` (pick the lowest-bitrate variant with audio); any other source that returns an `.m3u8` (direct URLs, or yt-dlp's `-g` output if item 11's package exports a resolver). Non-live inputs return a clear error pointing at the normal pipeline.
- Poll the media playlist at the target duration, download new media segments in order (track `EXT-X-MEDIA-SEQUENCE` so none are missed or repeated), and stop on `EXT-X-ENDLIST`.
- Window segments into chunks of `chunkSec` (default 30) with a 2 second overlap; extract audio to 16 kHz mono with ffmpeg (Node only; detect ffmpeg on PATH or `FFMPEG_PATH`, with a clear error when missing), transcribe each chunk through the core `transcribe` (so the free-first STT chain and cooldowns apply), offset segment times to stream time, and drop words duplicated in the overlap.
- Backpressure: if transcription falls behind by more than `maxLagSec` (default 120), skip ahead and emit a `status` event saying which span was skipped, rather than growing memory without bound.
- API: `watchLive(input, { maxMinutes?, chunkSec?, language?, signal? }, deps): AsyncIterable<LiveEvent>` where `LiveEvent` is `{ type: 'segment', segment } | { type: 'status', message } | { type: 'done', transcript }`. Resume: accept `{ fromSequence }` to continue after a restart.
- `src/mcp.ts`: `registerLiveTools(server, deps)` with `watch_live { url, maxMinutes? }` (default 10, capped at 60) sending progress notifications with the latest lines and returning the transcript. `src/http.ts`: `liveRoutes(deps)` with `GET /live` as server-sent events.
- Node only (ffmpeg); declare it in your README.

## Prefer free and local

Local speech-to-text rungs first when configured; the keyless OVH rung allows about 2 requests per minute, which suits 30 second chunks only barely: document that a free Groq key or a local rung is needed for streams longer than a few minutes, and make the chain's cooldown behaviour visible in `status` events.

## Out of scope

- YouTube's own live captions (not reliably reachable). Recording the stream to disk. Diarization (item 22).

## Tests

- Record real fixtures from a public-domain live stream (NASA's live streams are public domain; find one live): a master playlist, two successive media playlists, and three consecutive audio-bearing media segments (keep the total small; document the source and license). Trim signed query strings that embed your IP.
- Replay tests: sequence tracking across playlist refreshes, windowing and overlap dedupe on real STT output for those segments (record the keyless STT responses once with `LIVE=1`), `ENDLIST` handling, backpressure skip, resume from a sequence, cancellation.
- LIVE: follow a real live stream for 2 minutes and report the lines produced and the lag.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/live` prints nothing; `npx vitest run packages/live` passes; `npx biome check packages/live` is clean.
- [ ] LIVE result in your report, or the reason it could not run (no live stream found, ffmpeg missing, YouTube block).

## Docs

- `packages/live/README.md`: how it works, limits, which STT rungs keep up, cost of a long stream on each tier.

## If credentials, tools or network are missing

No key is needed for the keyless rung. If ffmpeg is missing, report it and test everything that does not need it.

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
