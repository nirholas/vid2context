# 60. More sources: cloud share links and Bilibili

| | |
|---|---|
| Track | N. Sources (wave 2) |
| You own | `providers/share-links/` (new package `@vid2context/provider-share-links`), `providers/bilibili/` (new package `@vid2context/provider-bilibili`) |
| Shared edits allowed | your rows in `docs/providers.md` and `.env.example`; your entry in `THIRD_PARTY_NOTICES.md` if you copy or port code (for example from yt-dlp's extractors, Unlicense) |
| Commit scope | `sources` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents. Two common inputs fall through wave 1. First, recordings shared as Google Drive, Dropbox or OneDrive links (lectures, meeting recordings, interviews): yt-dlp (item 11) handles only some of them, and only on Node. Second, Bilibili, one of the largest video sites in the world, which has creator subtitles reachable through its public API. Both work with plain fetch, so they also run on Workers.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `docs/contracts/providers.md` in full; `packages/core/src/types.ts`, `provider.ts`, `errors.ts`, `testing.ts`.
3. `providers/youtube/` and `providers/media-file/` as reference implementations; `providers/stt-openai-compatible/src/client.ts` (what audio input it accepts).
4. yt-dlp's extractors for Google Drive, Dropbox, OneDrive and Bilibili (Unlicense: you may port logic, add a `THIRD_PARTY_NOTICES.md` entry) to learn current URL shapes, confirm tokens and API parameters. Verify everything live.
5. `docs/prompts/SHARED-CONTRACTS.md` section 8; `docs/prompts/11-ytdlp.md` (stay a specific source; yt-dlp is the catch-all after you).

## Goal

`vid2context <a public Drive, Dropbox or OneDrive video link>` transcribes the file through the speech-to-text chain on Node and Workers; `vid2context https://www.bilibili.com/video/BV...` returns creator subtitles when the video has them, and otherwise audio for speech-to-text.

## Requirements

### Share links (`share-links`, runtimes node and workers)

- `match`: Google Drive (`drive.google.com/file/d/<id>/...`, `open?id=`, `uc?id=`), Dropbox (`dropbox.com/s/...`, `/scl/fi/...` with `rlkey`), OneDrive and SharePoint share links (`1drv.ms`, `onedrive.live.com`, `*.sharepoint.com/:v:/...`). Platform slugs `gdrive`, `dropbox`, `onedrive`; ids from the share id.
- `getMetadata`: filename as title, size and content type from a `HEAD` or ranged `GET` of the direct URL; private or deleted links map to `not-found` or `unavailable` with hints ("make the link viewable by anyone with the link").
- `getAudio`: return `{ kind: 'url' }` pointing at the direct download URL (Drive's large-file confirmation flow handled: detect the virus-scan interstitial and follow its confirm form; Dropbox `dl=1`; OneDrive's `download` redirect), with the mime type, so speech-to-text rungs download it. Files above the largest rung's `maxBytes` produce a clear `too-large` error naming item 04 (long audio) until that lands.

### Bilibili (`bilibili` source plus `bilibili-captions`, runtimes node and workers)

- `match`: `bilibili.com/video/BV...` and `av...`, `?p=` part numbers, `b23.tv` short links (resolve with one HEAD request inside `getMetadata`, not in `match`), `m.bilibili.com`.
- Metadata from the public view API (title, owner, description, duration, pages, tags, publish time, cover); multi-part videos: each part is a video ref; the ref for a multi-part URL without `p` is a playlist (`listItems` yields parts).
- Captions: creator CC subtitles from the player API's subtitle list (JSON body format with `from`, `to`, `content`) mapped to segments; AI-generated subtitles usually need a logged-in cookie: support `BILIBILI_SESSDATA` from `ctx.env` and mark those as `auto-captions`; never require it.
- Audio: take the DASH audio stream URL from the playurl API. Bilibili's media servers require a `Referer` header, which speech-to-text rungs cannot send when they download a `{ kind: 'url' }` input, so `getAudio` downloads the audio itself (with the Referer) and returns `{ kind: 'bytes' }`, bounded by `BILIBILI_MAX_AUDIO_MB` (default 50). Do not change the core `AudioInput` type.
- Respect the APIs' signing requirements (WBI signature for some endpoints) by porting the current algorithm from yt-dlp with attribution; verify it live.

## Prefer free and local

All keyless.

## Out of scope

- X Spaces, TikTok and other yt-dlp sites: item 11. Zoom cloud recordings (passcode-protected; leave out and say so). Downloading video streams.

## Tests

- Record real responses (public test files you upload yourself are not possible here, so find real public share links of public-domain or openly licensed recordings, for example a NASA or Internet Archive audio file mirrored on a public Dropbox or Drive link; document each source and license). If you cannot find a real public share link for one service, test that service's URL parsing only and report it.
- Bilibili: record the view API, subtitle list, a subtitle body and a playurl response for a public video with creator subtitles, plus a video without subtitles. Trim anything personal and any signed media URL query strings that embed your IP.
- Replay tests for matching, metadata, caption mapping, multi-part listing, error mapping; LIVE tests for each service.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/(share-links|bilibili)'` prints nothing; `npx vitest run providers/share-links providers/bilibili` passes; `npx biome check providers/share-links providers/bilibili` is clean.
- [ ] LIVE: one share link transcribed end to end through the keyless speech-to-text rung, and one Bilibili video returning creator subtitles; paste the first lines.

## Docs

- A README in each package; `BILIBILI_SESSDATA` and `BILIBILI_MAX_AUDIO_MB` in `.env.example` and `docs/providers.md` (your rows only).

## If credentials, tools or network are missing

No key is needed. If Bilibili blocks the machine's region or IP, keep the recorded fixtures you have and report it.

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
