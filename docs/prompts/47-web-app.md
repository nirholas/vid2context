# 47. The web app: paste a link or upload a video, get everything

| | |
|---|---|
| Track | H. Surfaces |
| You own | `packages/web/` |
| Shared edits allowed | None (the root `tsconfig.json` already excludes `packages/web`) |
| Commit scope | `web` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The web app is what most people will meet first. The owner's references define it: like xactions.app/video, you paste a link and press one button, with no login and recent results listed underneath; like llm.energy, the result page lists every generated file on the left with Copy and Download on each, a "Download .zip" button at the top, and text you can paste straight into an agent. On top of that, people can upload a video or audio file instead of a link, and jump into the chat page to ask questions with the LLM of their choice. The app renders formats and builds the .zip in the browser with `@vid2context/core`, so the server only returns `VideoContext` JSON.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/format/index.ts`, `packages/core/src/segments.ts` (`timestampUrl`, `formatTimestamp`), and `packages/core/src/errors.ts`.
3. `docs/contracts/http-api.md` (routes, error body, `Job` and its SSE events) and `packages/server/src/app.ts` (what exists today: `/health`, `/context`, `/transcript`).
4. `docs/prompts/SHARED-CONTRACTS.md` sections 2 (formatter ids, bundle layout), 3 (`/uploads`, `/bundle`), 6 in full (stack, URL layout, hand-off links, storage keys, design tokens, visual language) and 8.
5. The current landing page `site/index.html` (tone and copy already written for this project).

## Goal

A static React app at `/app/` where a user pastes any video link or drops a file, sees progress, and gets a result page with every format as a file they can copy or download, a .zip of everything, a one-click "Copy for agents", the transcript with timestamp links, chapters, metadata, comments, on-screen notes and an honest "how we got this" trail, plus batch runs for playlists, recent history and a settings page. It builds to static files that Cloudflare, Vercel and GitHub Pages can serve.

## Requirements

### Stack and build

- React 19, Vite with `base: '/app/'`, TypeScript, Tailwind CSS v4, `lucide-react`, self-hosted fonts via `@fontsource` (Inter, JetBrains Mono). Copy the tokens from SHARED-CONTRACTS section 6 into `src/styles/tokens.css` unchanged; dark by default, light and system themes via `data-theme` and `localStorage` `v2c.theme`.
- Own `tsconfig.json`, `vite.config.ts`, `index.html`. Scripts: `dev`, `build`, `preview`, `test`, `e2e` in `packages/web/package.json`.
- API base: `import.meta.env.VITE_API_BASE` (default `/api/v1`), overridable in Settings (`localStorage` `v2c.apiBase`). Vite dev server proxies `/api` to `http://127.0.0.1:8787`.
- No third-party requests at runtime (no CDNs, analytics or remote fonts). Initial JS under 200 KB gzipped; code-split the result viewer, uploads and the in-browser transcription path.

### Home

- One large rounded input: "Paste a YouTube, Vimeo, TikTok, podcast or any video link", with a gradient primary button "Get context". Enter submits.
- Directly under it, a drag-and-drop zone: "or drop a video or audio file", also clickable.
- "Try:" chips with real public videos (for example `jNQXAC9IVRw`, and the G-Wagon buyer video `cCPsdFdlshc` from the shared fixtures).
- Options row (collapsed by default): language, mode (Auto, Captions only, Speech-to-text, Video model), include comments, timestamps.
- `/app/?url=<encoded>&mode=&lang=` runs immediately (the landing page's hero submits here).
- A three-step "How it works" strip like xactions' (paste or drop; we fetch captions or transcribe, free first; copy, download or chat).

### Results (modeled on llm.energy's result page)

- Header: thumbnail, title, channel, duration, published date, and an origin badge in plain words ("Creator captions", "Auto-captions", "Transcribed by stt/ovh/whisper-large-v3-turbo", "Machine-translated").
- Left column: the bundle's files per SHARED-CONTRACTS section 2 (`context.md`, `transcript.md`, `transcript.srt`, `transcript.vtt`, `transcript.txt`, `context.json`, `metadata.json`, `chapters.md`, `comments.md`, `visual.md`), generated from the `formatters` map at runtime so new formats appear automatically. Each shows its size.
- Main viewer: the selected file in a monospace viewer with Copy and Download buttons. Top right: "Download .zip (N files)".
- Tabs: Transcript (timestamp links that open the source at that time via `timestampUrl`, a chapter jump list, search within the transcript with highlights), Chapters, Metadata, Comments, On screen, and "How we got this" (the `attempts` as a timeline: each provider or rung, stage, outcome, reason, time).
- Prominent "Copy for agents" button using `agentPrompt` from prompt 15, and "Open in chat" linking to `/chat/?input=<encoded input>`, where the user picks the LLM.
- The .zip uses `buildBundle` from `@vid2context/core` (prompt 15). Build everything else first; if `buildBundle` and `agentPrompt` still do not exist when you finish, leave the zip and agent-copy buttons out (no disabled placeholders) and report it. Formats beyond `text` and `json` likewise appear only as prompt 01 lands them.

### Playlists, channels and feeds

- When the input is a list, call `GET /items`, show the videos with checkboxes and a "Select all", then run the selected ones with a concurrency limit through `GET /context` (or through `POST /jobs` plus the SSE events when `/jobs` responds), showing per-item progress and errors, then offer one combined bundle.

### Uploads and client-only mode

- In the browser: decode with Web Audio `decodeAudioData`, downmix and resample to 16 kHz mono with an `OfflineAudioContext`, encode compactly (16-bit WAV chunks, or MP3 through a small encoder; choose, measure the size per minute, and document the choice), then `POST /uploads` and run the returned `upload:<sha256>` input. Show decode and upload progress. Reject unsupported files with a clear message.
- Client-only mode (API unreachable at startup, or built with `VITE_CLIENT_ONLY=1` for GitHub Pages): uploads are transcribed in the browser with the Transformers.js rung from prompt 19 if `providers/stt-transformers` exists when you finish (otherwise report it), and links show a plain explanation that they need an API server because YouTube blocks browser requests, with a link to Settings to set an API base.

### History, settings and errors

- Recent results like xactions' "Recent Downloads": thumbnail, title, format count, time ago; stored in IndexedDB `v2c-web` (results cached for instant reopen); "Clear history" with an inline confirmation.
- Settings: API base, theme, and provider keys for client-only mode stored in IndexedDB `v2c-settings` (store `kv`, key `providerKeys`) with a plain sentence about where they are stored and that they never go to the vid2context server.
- Errors always show the error's message, its hint and the attempts, never a bare "something went wrong".

### Quality

- WCAG 2.2 AA: keyboard reachable everything, visible focus, labels, live region for progress, contrast checked in both themes. Responsive down to 360 px.
- Copy rules: no em-dash or en-dash characters, no emojis, no invented numbers.

## Out of scope

- The chat page and model picker: prompt 28 (chat). Link to it.
- The landing page: prompt 36 (landing site). Server routes: prompt 46. The bundle and formatters themselves: prompts 15 and 01.
- Deploy assembly under `/app/`: prompt 50 (serverless and static) and 49 (containers).

## Tests

- Component tests with Vitest, jsdom and Testing Library on the real fixtures `tests/fixtures/contexts/*.json`: result header, file list built from `formatters`, viewer copy and download, transcript search, timestamp links, attempts timeline, error panel with hint.
- Upload pipeline: decode and resample the real `tests/fixtures/media/apollo11-small-step.mp3` (in a Playwright test, since jsdom has no Web Audio) and assert output sample rate and duration.
- Playwright e2e against a locally running server (`npm run start:server` on a random port, `vite preview` proxied): `LIVE=1` paste of `https://www.youtube.com/watch?v=jNQXAC9IVRw` end to end, file download, copy; upload of the Apollo clip end to end through keyless OVH Whisper.
- Accessibility check with `@axe-core/playwright` on home and results.

## Acceptance criteria

- [ ] `npm run build -w packages/web` succeeds; report the gzipped size of the initial JS.
- [ ] `npx vitest run packages/web` passes and `npx biome check packages/web` is clean.
- [ ] The Playwright e2e passes locally (or you report exactly which parts could not run).
- [ ] Opening `/app/?url=https://youtu.be/jNQXAC9IVRw` against the local server shows the result page with copyable files.
- [ ] Screenshots of home, results and an error state, taken from the running app, are in `docs/guides/web-app.md`.

## Docs

- `packages/web/README.md` (develop, build, env vars, client-only mode) and `docs/guides/web-app.md` (what each part of the UI does, with your screenshots).

## If credentials, tools or network are missing

No key is needed: YouTube captions and keyless OVH Whisper cover the live paths. If Playwright browsers cannot be installed, run the component tests, verify the built app manually with `vite preview`, and report what was not automated.

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
