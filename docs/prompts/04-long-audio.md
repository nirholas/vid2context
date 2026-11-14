# 04. Long audio: split, transcribe in parallel, stitch, resume

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/core/src/longform/` |
| Shared edits allowed | `packages/core/src/audio-split.ts` and `packages/core/src/storage-ext.ts` (create from SHARED-CONTRACTS 1.3 and 1.1 if missing); `packages/core/src/pipeline.ts` (use longform when audio exceeds every enabled rung's `maxBytes`; additive `splitters?: AudioSplitter[]` option); one `export *` line per new module in `packages/core/src/index.ts` |
| Commit scope | `longform` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. When a video has no captions, vid2context downloads the audio and runs a free-first speech-to-text chain. Hosted Whisper endpoints cap uploads (Groq at 25 MB), and today the pipeline simply skips rungs whose `maxBytes` is too small, so a 3-hour podcast or lecture fails. This prompt builds the long-audio orchestrator: split audio into chunks that fit, transcribe them in parallel across rungs so one rate limit does not stall the job, stitch the results with exact timestamps, and resume after a crash. It must run on Node and on Cloudflare Workers, so the built-in splitters are pure TypeScript.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (pipeline section).
2. `packages/core/src/types.ts` (`AudioInput`, `Segment`, `Transcript`, `Attempt`), `packages/core/src/provider.ts` (`SttRung`, `maxBytes`, `ChainOptions`), `packages/core/src/testing.ts`.
3. `packages/core/src/pipeline.ts` (`transcribe`, `fetchAudio`, `getVideoContext`), `packages/core/src/chain.ts` (`runChain`, `rankRungs`, cooldowns), `packages/core/src/storage.ts`.
4. `docs/contracts/providers.md` (rung and storage contracts).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (`storage-ext.ts`), 1.3 (`audio-split.ts`), 7 and 8.
6. `tests/fixtures/README.md` (`tests/fixtures/media/apollo11-small-step.mp3`, 24 s, mono 16 kHz, 48 kbps, public domain) and `providers/stt-openai-compatible/test/fixtures/README.md`.

## Goal

`transcribeLong(registry, ref, audio, opts, ctx)` turns audio of any length into one `Transcript` with correct global timestamps, using every enabled speech-to-text rung in parallel, checkpointing each finished chunk so a rerun skips it. `getVideoContext` uses it automatically when the audio is larger than every enabled rung accepts.

## Requirements

### Shared contract files

- `packages/core/src/audio-split.ts` and `packages/core/src/storage-ext.ts`: if missing, create them exactly as SHARED-CONTRACTS sections 1.3 and 1.1 show, following its procedure (commit each on its own right away). Use them as is.

### Built-in splitters (runtime-neutral, implementing `AudioSplitter`)

- `mp3FramesSplitter` (id `mp3-frames`): skip ID3v2 tags (size from the synchsafe header), detect and skip a Xing/Info/VBRI header frame, walk MPEG-1/2/2.5 Layer III frame headers (bitrate and sample-rate tables, padding bit, frame length formula), cut only on frame boundaries, compute time from frame counts (1152 or 576 samples per frame), handle VBR and free-format errors (resync on the next valid header), and keep each chunk at most `maxBytes`. Prefer cuts near `targetSec`; MP3 frame splitting cannot detect silence cheaply, so state that in the docs.
- `wavPcmSplitter` (id `wav-pcm`): parse RIFF chunks (`fmt `, `data`, skip unknown chunks such as `LIST`), slice PCM on sample-frame boundaries, write a correct 44-byte header per chunk. Optionally pick cut points at the lowest-energy window near `targetSec` (cheap RMS over 20 ms frames): WAV can do real silence detection, so do it.
- Overlap: each chunk after the first starts `overlapSec` (default 2 s) before the previous chunk's end; record `overlapSec` on the chunk.
- Other containers (m4a, aac, opus, ogg, webm, mp4): no built-in splitter. Prompt 12 builds an ffmpeg-based `AudioSplitter` for Node; it arrives through the `splitters` option. Without a capable splitter, fail with `Vid2ContextError('too-large')` and a hint naming the fix (install the yt-dlp and ffmpeg providers so audio arrives as small mono MP3, or pass an ffmpeg splitter).
- `AudioInput` of kind `url`: fetch with `ctx.fetch` into bytes with a size cap (`VID2CONTEXT_MAX_AUDIO_MB`, default 1024) before splitting.

### Orchestrator `transcribeLong`

- Plan: rank enabled STT rungs with `rankRungs(registry.sttRungs(ctx.env), chain, ctx.env)`; choose the chunk byte limit from the smallest `maxBytes` among the top rungs that will be used (rungs without `maxBytes` accept any size), with a 5 percent margin; target about 10 minutes per chunk.
- Run chunks with bounded concurrency (`opts.concurrency`, default 3). Spread chunks across rungs so one rung's rate limit does not stall everything: each chunk calls `runChain` with an `only`/order that starts at a different rung (round-robin over the ranked list) and falls back along the rest. Cooldowns from `chain.ts` apply naturally.
- Offset every segment by the chunk's `startSec`. Stitch overlaps: align words in the overlap window of chunk N and chunk N+1 (normalized words, longest common run), drop the duplicate words from the later chunk, and cut at the midpoint of the aligned run. If alignment fails, cut at the overlap midpoint by time and report it.
- Merge `attempts` from every chunk (prefix detail with `chunk i/n`), and return `{ transcript, attempts, chunks: n }`. `transcript.producer` names the rung that produced most chunks; `transcript.model` likewise; `language` is the majority language.
- Progress: an optional `onProgress({ done, total, message })` callback, matching the job progress shape in `docs/contracts/http-api.md`.
- Abort: honour `ctx.signal`; stop scheduling new chunks and reject with the abort reason.

### Resume

- Checkpoint each finished chunk's segments in a `KvStore`: `hasKv(storage) ? storage : new MemoryKv()`, key `longform:<refId>:<audioSha256>:<chunkIndex>` (sha256 via `crypto.subtle`), TTL 7 days. A rerun with the same audio skips finished chunks and reports them as `outcome: 'ok', reason: 'resumed'` attempts.

### Pipeline hook (shared edit)

- Add `splitters?: AudioSplitter[]` to `GetContextOptions` and to the `transcribe` options. In `transcribe` (or right before it is called), when the audio is bytes and larger than every enabled rung's `maxBytes` that the chain would use, call `transcribeLong` with the built-in splitters plus `opts.splitters`. Re-read `pipeline.ts` right before editing (prompts 02, 10, 21, 22 and 42 edit it too); keep the change small and do not reformat.

## Prefer free and local

Splitting is local. Parallel transcription uses the normal free-first chain: local rungs first, then free tiers (Groq), then the keyless OVH lane. Note in the docs that OVH keyless allows about 2 requests per minute per IP, so a long file on keyless alone is slow but works; adding a free Groq key makes it fast.

## Out of scope

- The ffmpeg splitter and audio normalization (prompt 12, `packages/ffmpeg`).
- Speech-to-text rungs themselves (prompts 17 to 20, 22).
- The jobs system and SSE progress (prompt 42); you only expose `onProgress`.
- Caption cleanup (prompt 02); its repetition guard runs on your stitched output in the pipeline.

## Tests

Put tests in `packages/core/test/longform/`, fixtures in `packages/core/test/fixtures/longform/` with a `README.md`.

- MP3 splitter on the real `tests/fixtures/media/apollo11-small-step.mp3` with a small `maxBytes` (for example 40 KB): assert every chunk starts with a valid frame header, durations sum to the file duration within one frame, byte sizes are within the cap, overlaps are as configured.
- A longer real public-domain recording for stitching (a LibriVox or NASA mp3 of a few MB at most; record source and license in the fixtures README), split into 3 or 4 chunks; record the real OVH keyless response for each chunk once with `LIVE=1`, then replay them through `replayFetch` and assert stitched timestamps are monotonic, no duplicated words at the seams, and the text matches a single-pass transcript in word overlap (report the measured similarity).
- WAV splitter: convert the apollo clip to WAV once with ffmpeg (document the command), commit it, and assert header correctness and silence-aware cut points.
- Resume: run with a `MemoryKv`, abort after the first chunk (via `AbortController`), rerun, and assert only the remaining chunks hit the network (count `replayFetch.calls`).
- Unsupported container without a splitter: assert the `too-large` error and hint.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/core/src/(longform|pipeline|audio-split|storage-ext)'` prints nothing.
- [ ] `npx vitest run packages/core/test/longform` passes, and `npx vitest run packages/core` still passes.
- [ ] `npx biome check packages/core/src/longform packages/core/test/longform` is clean.
- [ ] With `LIVE=1`, a real 30-minute or longer public-domain MP3 transcribes end to end through the keyless chain (or a free key if present); report duration, chunk count, wall time and rungs used.

## Docs

- Create `docs/long-audio.md`: when longform kicks in, splitters and their limits, concurrency and rung spreading, stitching, resume keys, and real timings from your live run.

## If credentials, tools or network are missing

Splitters and stitching tests run offline on committed fixtures. If no STT rung is reachable to record per-chunk responses, ship the splitters and the orchestrator only with tests you could back by real recordings; report the live run as not done.

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
