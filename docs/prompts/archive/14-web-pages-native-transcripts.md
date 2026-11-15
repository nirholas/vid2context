# 14. Web pages with embedded video, and Vimeo, Loom, Wistia transcripts

| | |
|---|---|
| Track | C. Other sources |
| You own | `providers/web-page/`, `providers/native-transcripts/` (Vimeo, Loom and Wistia as separate provider ids in one package) |
| Shared edits allowed | Your own rows in `docs/providers.md` and variables in `.env.example` |
| Commit scope | `sources` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Two gaps remain after YouTube and yt-dlp. First, people paste article and course URLs that embed one or more videos; vid2context should find those videos and offer them. Second, Vimeo, Loom and Wistia often already have creator captions or transcripts reachable without a key; fetching them is faster, cheaper and more accurate than downloading audio for speech-to-text. This prompt covers both, and merges roadmap items 14 (native transcripts) and 15 (web page discovery).

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts` (`SourceProvider` with `catchAll` and `listItems`, `CaptionsProvider`), `packages/core/src/registry.ts` (`resolve` orders specific sources before catch-alls), and `packages/core/src/testing.ts`.
3. `docs/contracts/providers.md` (source and captions rules, ref ids), `docs/contracts/http-api.md` (`GET /items` expands pages) and `docs/contracts/mcp-tools.md` (`list_items`).
4. `providers/youtube/src/url.ts` (to recognize YouTube embeds and turn them into the YouTube provider's URL form).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7 and 8.

## Goal

`page:<url>` and `discoverVideos(url, ctx)` return every video embedded in a web page, de-duplicated, in page order, as inputs other providers resolve. Vimeo, Loom and Wistia URLs resolve to metadata and, where a keyless path exists and was verified live today, creator captions or native transcripts.

## Requirements

### `providers/web-page` (runtimes node, workers)

- Do not hijack yt-dlp's catch-all (prompt 11 matches any http(s) URL, and yt-dlp's generic extractor already handles a page with a single embed). So `match` accepts only explicit `page:<http(s) url>` inputs, returning a ref with `kind: 'page'`. Document the form.
- Export `discoverVideos(url, ctx): Promise<DiscoveredVideo[]>` (`{ input, platform, title?, source: 'iframe' | 'video-tag' | 'og' | 'json-ld' | 'oembed' | 'link' }`) for surfaces to call directly on any URL (the CLI, the web app's fallback when a URL fails).
- Fetch safely: http(s) only, a byte cap (2 MB of HTML), a timeout, a redirect limit, and refuse private or loopback hosts (implement a small local check; prompt 10 builds the shared hardened version later).
- Parse HTML with a light parser that runs on Workers (for example `htmlparser2`, or a careful tokenizer of your own). Discover: iframes for YouTube (`/embed/`, `youtube-nocookie.com`), Vimeo (`player.vimeo.com/video/`), Loom (`loom.com/embed/`), Wistia (`fast.wistia.net/embed/`, `wistia.com/medias/`, the `wistia_async_<id>` class), Dailymotion, Twitch, Rumble; `<video>` and `<source>` URLs (resolved against the page URL); Open Graph `og:video` and `og:video:url`; JSON-LD `VideoObject` (including `@graph` arrays) with `embedUrl`, `contentUrl`, `name`, `uploadDate`, `duration` and `transcript`; oEmbed discovery links; plain anchor links to video pages.
- A JSON-LD `transcript` property is a native transcript: return it through a captions provider `web-page-transcript` with `origin: 'native-transcript'` (untimed text becomes one segment per paragraph without invented timings: use the video duration only if known, otherwise mark segments as untimed in `producer` and document it).
- `listItems(pageRef)` yields refs for each discovered video by resolving the discovered input through the rest of the registry's URL forms; skip and log anything no source understands.

### `providers/native-transcripts` (runtimes node, workers)

- Vimeo (`vimeo`, source plus captions provider `vimeo-captions`): match `vimeo.com/<id>`, unlisted `vimeo.com/<id>/<hash>`, `player.vimeo.com/video/<id>`(`?h=<hash>`), and showcase or channel video URLs. Metadata from oEmbed (`https://vimeo.com/api/oembed.json?url=`) and the public player config JSON (`https://player.vimeo.com/video/<id>/config`): title, owner, duration, thumbnail, upload date. Captions from the config's `text_tracks` (WebVTT): creator tracks as `creator-captions`, auto-generated tracks (language codes like `en-x-autogen`) as `auto-captions`. Private, password or login-only videos throw `unavailable` with a hint. Audio for speech-to-text comes from yt-dlp (prompt 11), so `canProvideAudio` is false here.
- Loom and Wistia: implement only what is reachable keyless and verified live today. Candidates to verify: Loom share pages (`loom.com/share/<id>`) and the transcript data they load; Wistia media JSON (`fast.wistia.com/embed/medias/<id>.json`) and its captions endpoint. Verify each endpoint first with a real public video and record the responses. If a platform has no working keyless path, do not ship a provider for it, and explain why in the docs and the final report. No guessing at undocumented endpoints you could not call.
- Parse WebVTT robustly (BOM, CRLF, cue settings, `NOTE` blocks, multi-line cues, rolling duplicates).

## Prefer free and local

All of this is keyless. Platform captions beat speech-to-text: the captions providers here run before audio in the pipeline, so a video with creator captions never costs a speech-to-text call.

## Out of scope

- yt-dlp as the universal fallback and audio source: prompt 11.
- YouTube itself: prompts 06 to 09.
- Collections that follow a page: prompt 41. Surfaces calling `discoverVideos`: prompts 43, 46, 47.

## Tests

- Record real pages into `providers/web-page/test/fixtures/` (trim to the relevant HTML, keeping structure, and note it): an article with a YouTube iframe and a Vimeo iframe, a page with JSON-LD `VideoObject` (ideally with `transcript`), a page with a `<video>` tag, a page with `og:video`. Note each URL and date in the README.
- Record real Vimeo oEmbed and player config responses for a public video with creator captions, and the VTT track; record a real response for a private or password video. Same for whichever Loom and Wistia endpoints you verified.
- Assert: `page:` matching only, discovery of every embed type, de-duplication and page order, relative URL resolution, byte cap and private-host refusal, Vimeo URL forms, track origin mapping, VTT parsing to segments, error codes for private videos.
- LIVE: discover videos on a real article; fetch Vimeo captions for a real public video end to end through the pipeline.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/(web-page|native-transcripts)'` prints nothing.
- [ ] `npx vitest run providers/web-page providers/native-transcripts` passes; `npx biome check providers/web-page providers/native-transcripts` is clean.
- [ ] A plain `https://vimeo.com/<id>` URL resolves to `vimeo`, not to yt-dlp, and returns creator captions without speech-to-text (LIVE).
- [ ] `page:<real article URL>` expands to the embedded videos through `expandInput` (LIVE).
- [ ] The report states, per platform (Loom, Wistia), whether a keyless path was verified and shipped.

## Docs

- `docs/guides/web-pages.md`: the `page:` form, what discovery finds, Vimeo captions, the status of Loom and Wistia with the date verified.
- Your rows in `docs/providers.md` and any env var in `.env.example`.

## If credentials, tools or network are missing

No keys are needed. Without network you cannot verify Loom or Wistia endpoints, so do not ship those providers; build Vimeo and page discovery from already recorded real fixtures only if you have them, otherwise report everything as unverified.

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
