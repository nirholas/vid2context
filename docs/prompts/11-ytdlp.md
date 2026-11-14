# 11. yt-dlp universal source with a self-managed binary

| | |
|---|---|
| Track | C. Other sources |
| You own | `providers/ytdlp/` (new package `@vid2context/provider-ytdlp`, runtime `node` only, `catchAll: true`) |
| Shared edits allowed | your rows in `docs/providers.md` and `.env.example` |
| Commit scope | `ytdlp` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. yt-dlp is what makes "any video" true: it supports more than a thousand sites (Vimeo, TikTok, X, Instagram, Reddit, Twitch VODs, Loom, Rumble, news sites with embedded players) and it is the audio path for YouTube videos that have no captions, which then go through the free-first speech-to-text chain. It is not installed system-wide on the owner's VM, and a copy in an old scratchpad was wiped, so the provider must manage its own binary: find it, or download and verify the official release, and keep it updated. yt-dlp 2026 also needs a JavaScript runtime for YouTube (deno by default, or `--js-runtimes node`). DRM services (Netflix, Spotify, Disney+) are out of scope.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (source resolution order, catch-alls, `canProvideAudio`).
2. `packages/core/src/types.ts` (`VideoRef`, `VideoMetadata`, `AudioInput`, `Comment`), `packages/core/src/provider.ts` (`SourceProvider`, `CaptionsProvider`, `catchAll`), `packages/core/src/pipeline.ts` (`fetchAudio` and how other sources supply audio for YouTube refs), `packages/core/src/testing.ts`.
3. `providers/media-file/src/index.ts` (a node-only provider example) and `providers/youtube/src/` (how YouTube refs and ids look: yours must produce the same `youtube:<id>` ids for YouTube URLs so caching works).
4. `docs/contracts/providers.md`, `docs/providers.md`, `.env.example`.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7, 8 and 9 (the `.vid2context/bin/` and `locks/` layout).

## Goal

Any http(s) video URL that no specific provider claims resolves through yt-dlp to metadata, captions (when the site has them) and compact speech-ready audio; YouTube refs can get audio from yt-dlp when captions are missing; the binary installs, verifies and updates itself, and every yt-dlp failure becomes a clear error with a hint.

## Requirements

### Binary management (`src/binary.ts`)

- Resolution order: `YTDLP_PATH`; `yt-dlp` on `PATH`; a managed copy in `.vid2context/bin/` (or `$VID2CONTEXT_HOME/bin/`).
- Managed install: download the official release asset for the platform from `https://github.com/yt-dlp/yt-dlp/releases/latest/download/` (`yt-dlp_linux`, `yt-dlp_linux_aarch64`, `yt-dlp_macos`, `yt-dlp.exe`), verify its SHA-256 against the release's `SHA2-256SUMS`, write atomically (temp file then rename), `chmod 755`, record the version (`yt-dlp --version`) in a small JSON next to it.
- A file lock (`.vid2context/locks/ytdlp`, an exclusive create with stale-lock detection) so parallel processes do not download twice.
- Update check at most weekly for the managed copy (`YTDLP_AUTO_UPDATE=0` disables): compare the latest release tag via the GitHub API or the redirect target of `releases/latest`, then re-download and verify. Never self-update a user-supplied binary.
- `ensureYtDlp(ctx)` returns `{ path, version, managed, jsRuntime }` and is exported for the CLI's `doctor` (prompt 43). Also ship `src/setup.ts`, runnable as `npx tsx providers/ytdlp/src/setup.ts`, that installs and prints the result.

### JS runtime and ffmpeg

- Detect `deno` on PATH (yt-dlp's default); otherwise pass `--js-runtimes node` (Node is always present). Report which in health and in `ensureYtDlp`.
- ffmpeg: `--ffmpeg-location` from `FFMPEG_PATH`, else `ffmpeg` on PATH, else `~/.local/bin/ffmpeg` (where it lives on the owner's VM). Without ffmpeg, audio extraction fails with a hint naming how to install it (and prompt 12's managed ffmpeg).

### Source provider `ytdlp`

- `catchAll: true`; `match(input)` accepts any `http:` or `https:` URL (synchronous, no network) and returns a ref. For YouTube URLs, delegate id extraction so the ref id equals the YouTube provider's (`youtube:<id>`); since the YouTube provider wins resolution for those, this matters only for audio and caching. For other sites, `platform` is the yt-dlp extractor key when knowable cheaply from the host, else `web`, and `nativeId` a stable hash of the canonical URL until metadata reveals the extractor id (document the choice).
- `getMetadata`: `yt-dlp -J --no-download --no-playlist --no-warnings -- <url>`, mapped to `VideoMetadata`: title, uploader and channel URL, duration, `upload_date` to ISO, description, chapters (`start_time`, `end_time`, `title`), best thumbnail, tags, language, `is_live`, `extra.extractor`, `extra.webpageUrl`.
- `listItems` for playlist and channel URLs: `--flat-playlist -J`, yielding refs in order, honouring `limit` (`--playlist-end`).
- `getComments` when requested: `--write-comments` with `--extractor-args` limits where the extractor supports them, bounded by `limit`, mapped to `Comment`.
- `canProvideAudio(ref)`: true for http(s) video refs including YouTube. `getAudio`: `-f bestaudio/best -x --audio-format mp3 --postprocessor-args "ffmpeg:-ac 1 -ar 16000 -b:a 32k"` into a temp directory (`os.tmpdir()`), read bytes, delete the temp files, and return `{ kind: 'bytes', data, mimeType: 'audio/mpeg', filename, durationSec }`. 32 kbps mono is about 14 MB per hour, under Groq's 25 MB limit for about 1.7 hours; longer audio is split by the long-audio orchestrator (prompt 04).

### Captions provider `ytdlp-captions`

- `supports(ref)`: non-YouTube http(s) refs, and YouTube refs as a fallback (it runs after `youtube-captions` because providers are ordered by package directory; verify that order in the generated registry and report it).
- `--skip-download --write-subs --write-auto-subs --sub-langs <lang or all-but-live-chat> --sub-format vtt/srv3/best`, then parse with a robust WebVTT parser in your package (cue settings, `<c>` and timestamp tags inside cues, rolling auto-caption duplicates collapsed conservatively). Origin `creator-captions` for uploaded subtitles, `auto-captions` for automatic ones. Respect `language` and `allowAuto`.

### Process safety

- Spawn with `child_process.spawn` and an argument array, never a shell. Always put `--` before the URL; reject inputs starting with `-`. Timeouts per command (`YTDLP_TIMEOUT_SEC`, default 300 for audio, 60 for metadata). Kill the process tree on `ctx.signal` abort. Capture stderr with a size bound.
- Map known stderr messages to codes with hints: "Sign in to confirm you're not a bot" (`blocked`, with the tunnel and cookies hints), "Video unavailable" and "This video has been removed" (`not-found`), "Private video" (`unavailable`), "Unsupported URL" (`unsupported-input`), HTTP Error 429 (`rate-limited`), "Requested format is not available" (`unavailable`), missing ffmpeg (`no-provider`).
- Cookies: `YTDLP_COOKIES_FILE` (`--cookies`) and `YTDLP_COOKIES_FROM_BROWSER` (`--cookies-from-browser`). Never log their values or paths' contents.
- Concurrency: at most `YTDLP_CONCURRENCY` (default 2) yt-dlp processes per Node process.

## Prefer free and local

yt-dlp runs locally and needs no key. The audio it produces feeds the free-first STT chain (local, then free Groq, then keyless OVH). Running on a residential IP avoids most blocks.

## Out of scope

- YouTube innertube captions and metadata (prompts 06, 07); local files and direct media URLs, HLS, ffmpeg management (prompt 12); long-audio splitting (prompt 04); speech-to-text rungs (prompts 17 to 20).

## Tests

- Record real fixtures into `providers/ytdlp/test/fixtures/` (document each in its `README.md`, strip stream URLs that embed your IP): `-J` output for a YouTube video (`jNQXAC9IVRw`), a public Vimeo video and one more site (for example a public Internet Archive item or a Reddit or X video); a `--flat-playlist -J` output; real `.vtt` subtitle files (creator and auto); real stderr outputs for "Unsupported URL" and an unavailable video.
- Unit tests: metadata mapping from each `-J` fixture; VTT parsing; stderr to error mapping; argument building (assert exact argv arrays, `--` placement, rejection of `-` inputs); lock behaviour with two concurrent `ensureYtDlp` calls in temp dirs using a real downloaded binary is a LIVE test.
- LIVE tests: install the managed binary into a temp `VID2CONTEXT_HOME`, verify the checksum, read its version; fetch metadata and audio for a short public-domain video; transcribe that audio through the keyless chain with `getVideoContext(..., { mode: 'stt' })`.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/ytdlp'` prints nothing.
- [ ] `npx vitest run providers/ytdlp` passes; `npm run gen` lists the new provider for the node runtime only.
- [ ] `npx biome check providers/ytdlp` is clean.
- [ ] Live: `npm run cli -- <a public Vimeo URL>` returns a transcript (captions or STT); `npm run cli -- https://www.youtube.com/watch?v=jNQXAC9IVRw --mode stt` transcribes YouTube audio fetched by yt-dlp. Paste the attempts in your report.

## Docs

- `docs/guides/ytdlp.md`: what it covers, binary management and updates, JS runtime, ffmpeg, cookies, every env var, error meanings, and the DRM exclusion.
- `docs/providers.md` and `.env.example`: `YTDLP_PATH`, `YTDLP_AUTO_UPDATE`, `YTDLP_TIMEOUT_SEC`, `YTDLP_CONCURRENCY`, `YTDLP_COOKIES_FILE`, `YTDLP_COOKIES_FROM_BROWSER`, `FFMPEG_PATH` (if not already listed).

## If credentials, tools or network are missing

No key is needed. Without network access to GitHub, use a yt-dlp on PATH if one exists, otherwise ship the provider with recorded-fixture tests only and report that install, update and live audio were not verified. Without ffmpeg, verify metadata and captions, and report audio as unverified.

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
