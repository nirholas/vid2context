# 31. On-screen text and slides: frames, OCR and vision models

| | |
|---|---|
| Track | F. Intelligence |
| You own | `providers/visual-frames/` |
| Shared edits allowed | `docs/providers.md` and `.env.example` (your rows and variables only) |
| Commit scope | `visual` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. A transcript misses what is only shown: the slide with the benchmark table, the code on screen, the price list in a buyer's guide. Prompt 30 gets on-screen content from Gemini by URL, which needs a key and sends the video to Google. This prompt builds the local, free-first alternative that works for any video file: sample frames where the picture changes, drop near-duplicates, and read each distinct frame with local OCR (tesseract.js) or a vision model (keyless OVH Qwen2.5-VL, local Ollama vision models, Gemini), producing timed `VisualNote`s that land in `VideoContext.visual` and render alongside the transcript.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`VisualNote`, `VideoContext.visual`), `packages/core/src/provider.ts` (`VisualRung` with `read(frame, ctx)`, `VisualProvider`, `rungs(env)`), `packages/core/src/chain.ts` (`runChain`), `packages/core/src/keys.ts`, `packages/core/src/testing.ts`.
3. `providers/llm-openai-compatible/` (how OVH keyless requests are made) and `providers/media-file/` (local file handling).
4. `docs/contracts/providers.md`, `docs/providers.md`, `tests/fixtures/README.md`.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7, 8 and 9.

## Goal

`extractVisualNotes(input, opts, ctx)` turns a local video file (or a URL the yt-dlp binary can download) into a short, deduplicated, time-sorted list of `VisualNote`s, using visual rungs from the registry in free-first order, with a hard cap on how many frames are sent to any hosted model.

## Requirements

### Package

- `@vid2context/provider-visual-frames`. It contains two parts with different runtimes; split them so the registry codegen stays correct:
  - The visual rungs (`VisualProvider`, id `visual-frames`): runtimes `node`, `workers`, `browser` for the HTTP vision rungs; tesseract.js works in Node and the browser (not Workers): if one package cannot declare different runtimes per rung, put the tesseract rung behind an env-only `isEnabled` that is false on Workers, or split it into a second provider entry exported only from a Node/browser module. Choose the simplest correct structure and document it.
  - The frame pipeline (`extractVisualNotes`, frame sampling, hashing): Node only, exported from a subpath (`@vid2context/provider-visual-frames/node`) that edge builds never import.

### Frame sampling (Node)

- Input: a local file path, or a URL. For URLs, download a low-resolution video with the yt-dlp binary when it is available (`YTDLP_PATH` or on PATH; `-f "bv*[height<=480]/b[height<=480]"`, no audio needed), into a temp dir under `.vid2context/cache`, cleaned up afterwards. If yt-dlp is missing, fail with a hint naming prompt 11's provider and `YTDLP_PATH`.
- ffmpeg (`FFMPEG_PATH` or PATH; on this VM `/home/user/.local/bin/ffmpeg`): scene-change sampling (`select='gt(scene,THRESH)'`, threshold configurable, default 0.3) plus a maximum interval fallback (a frame at least every N seconds, default 30) and a minimum interval (default 2 s), scaled to a fixed width (default 1024), JPEG output with timestamps from `showinfo` or frame pts. Spawn without a shell, abort on `ctx.signal`.
- Dedupe: perceptual difference hash (dHash, 64-bit) computed in pure TypeScript on downscaled grayscale pixels (decode JPEG with a small pure-JS decoder or have ffmpeg emit raw gray frames alongside); collapse consecutive frames within a Hamming distance threshold, keeping the sharpest (highest variance) frame of each run.
- Budget: `maxFrames` (default 40) sent to rungs; when there are more distinct frames, keep the ones with the largest visual change, spread across the duration.

### Visual rungs

- `visual/tesseract/<lang>` (tier `local`): tesseract.js with languages from `TESSERACT_LANGS` (default `eng`), enabled by `TESSERACT_ENABLED=1` (or default on in Node: decide and document), returns `ocr` notes; skip frames with little text (confidence and length thresholds).
- `visual/ovh/Qwen2.5-VL-72B-Instruct` (tier `keyless`, listed in OVH's `/v1/models`; verify vision input works live with an image data URL), `visual/ollama/<model>` (tier `local`, `OLLAMA_VISION_MODEL` such as `qwen2.5vl` or `llava`), `visual/gemini/<model>` (tier `free`, `GEMINI_API_KEY`, `GEMINI_VISION_MODEL`). Each asks for JSON: a `kind` (`slide`, `code`, `chart`, `ocr`, `description`) and `text` with on-screen text copied exactly (code preserved verbatim, tables as Markdown), and a one-line description only when there is no text.
- Rungs implement `read(frame, ctx)` and are run per frame through `runChain` from core, so cooldowns and fallbacks apply; keyless OVH allows about 2 requests per minute, so throttle per service and let the chain move on.

### Output

- `VisualNote[]` sorted by `atSec`, with `producer` set to the rung id, merging consecutive notes with near-identical text (normalized) into the first occurrence.
- `extractVisualNotes(input, { maxFrames, sceneThreshold, minIntervalSec, maxIntervalSec, chain }, ctx)` returns `{ notes, frames: { atSec, hash, sentTo? }[], attempts }`. Export it so the pipeline integration (wave 2) can attach notes to a context.

## Prefer free and local

Order: tesseract.js and local Ollama vision first, then free Gemini, then keyless OVH. Under `local-only`, only tesseract and Ollama run. The frame budget keeps hosted use small.

## Out of scope

- Gemini whole-video understanding by URL: prompt 30. Rendering notes in Markdown and the pack: prompt 01. Wiring visual notes into `getVideoContext` options and surfaces: the integration pass.

## Tests

- Fixtures in `providers/visual-frames/test/fixtures/` (README per file with source and license): a short CC-licensed or public-domain slide talk or screencast clip (a few MB at most; trim with ffmpeg and record how), a handful of real frames extracted from it, and real recorded vision responses from OVH keyless (record live) plus Ollama or Gemini if available.
- Unit tests: dHash on the real frames (identical slides collapse, different slides do not), budget selection, note merging, rung request building with an image data URL, JSON parsing and kind mapping, tesseract OCR on a real frame with known text (assert key words, not exact output).
- LIVE test: end to end on the clip with ffmpeg present, asserting the expected slides appear with times within a few seconds.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/visual-frames'` prints nothing.
- [ ] `npx vitest run providers/visual-frames` passes; `npx biome check providers/visual-frames` is clean.
- [ ] `npx tsx -e` (or a small script) running `extractVisualNotes` on the fixture clip prints sensible timed notes using only local and keyless rungs.
- [ ] The workers registry contains no Node-only module from this package.

## Docs

- `docs/guides/visual-notes.md`: what it captures, the sampling and dedupe knobs, rung order, privacy (local OCR never leaves the machine), costs and limits.
- Rows in `docs/providers.md` and variables in `.env.example`.

## If credentials, tools or network are missing

Without ffmpeg, frame sampling cannot run: test hashing and rungs on committed real frames and report that sampling was not verified. Without network, use only tesseract and recorded responses. Never fabricate a vision response.

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
