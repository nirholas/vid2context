# 53. SponsorBlock: skip sponsor reads, intros and self-promotion

| | |
|---|---|
| Track | K. Content quality (wave 2) |
| You own | `packages/skips/` (new package `@vid2context/skips`) |
| Shared edits allowed | your rows in `docs/providers.md` and `.env.example`; your entry in `THIRD_PARTY_NOTICES.md` (data attribution) |
| Commit scope | `skips` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents, and briefs built from it cite what each video says. YouTube reviews are full of sponsor reads ("this video is brought to you by..."), subscribe reminders and long intros. In a cited brief about which G-Wagon to buy, ad copy is noise that can even be mistaken for a claim. SponsorBlock is a free, crowdsourced database of exactly these segments for YouTube videos, with a privacy-preserving API. kimtaeyoon83/mcp-server-youtube-transcript (MIT) offers a similar `strip_ads` option. No wave-1 prompt does this.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (the "keep raw transcripts" rule).
2. `packages/core/src/types.ts` (`Transcript`, `Segment`, `VideoRef`), `segments.ts`, `errors.ts`, `context.ts` (`fetchWithTimeout`), `testing.ts`.
3. `docs/contracts/mcp-tools.md` and `docs/contracts/http-api.md`, "Wave 2" sections (`get_skip_segments`, `GET /skips`, the `skip=` transcript option).
4. SponsorBlock's API documentation (wiki.sponsor.ajay.app, "API Docs") and its database license (CC BY-NC-SA 4.0). Verify the current endpoints and categories live.
5. `docs/prior-art.md` (the data-license row) and `docs/prompts/SHARED-CONTRACTS.md` section 8.

## Goal

For a YouTube video with community segments, `getSkipSegments(ref, ctx)` returns them, and `applySkips(transcript, segments)` returns a new transcript layer without the sponsor and self-promotion lines, while the raw transcript stays untouched and stored.

## Requirements

- `getSkipSegments(ref: VideoRef, ctx: Ctx, opts?: { categories?: SkipCategory[]; minVotes?: number })`: YouTube refs only (return `[]` for others). Use the hash-prefix endpoint (`/api/skipSegments/<first 4 hex chars of sha256(videoId)>`) so the video id is not sent, then filter the response to the exact video. Categories default to `sponsor`, `selfpromo`, `interaction`, `intro`, `outro`, `preview`, `filler`; also expose `music_offtopic` and `poi_highlight` (a highlight is a point, not a skip: return it separately as `highlight`). Respect `actionType` (`skip`, `mute`, `chapter`, `poi`, `full`): `full` means the whole video is sponsored or exclusive access; report it as a flag, never drop the whole transcript.
- `SkipSegment` type in your package: `{ category, startSec, endSec, votes, uuid, actionType }`. Prefer segments with more votes when they overlap; drop segments with negative votes or below `minVotes` (default 0).
- `applySkips(transcript, segments, opts?: { mode?: 'drop' | 'mark'; minOverlap?: number })`: returns `{ transcript: Transcript, removed: { segment: SkipSegment; lines: number; text: string }[], coveredSec }`. `drop` removes transcript segments overlapping a skip by at least `minOverlap` (default 0.5 of the line's duration). `mark` keeps every line with its text unchanged and returns the indexes of the overlapping lines in `removed`, so a formatter can label them. Never repurpose `Segment.speaker` for this: it names people. The returned transcript has `producer: '<original producer>+skips'`. The input object is never mutated.
- Errors: network failures and 5xx become `Vid2ContextError('upstream')` with a hint; a 404 from the API means "no segments" and returns `[]`. Timeouts short (5 seconds): skipping ads must never block getting a transcript.
- Env: `VID2CONTEXT_SPONSORBLOCK=0` disables lookups; `SPONSORBLOCK_API_URL` overrides the base URL (for self-hosted mirrors); `VID2CONTEXT_SKIP_CATEGORIES` sets defaults. Read from `ctx.env`.
- `src/mcp.ts`: `registerSkipsTools(server, deps)` with `get_skip_segments { url, categories? }` (segments plus the transcript share each covers and the attribution line). `src/http.ts`: `skipsRoutes(deps)` with `GET /skips`. Export `skipQueryOption(transcript, ctx, skip: string)` so item 46 can honour `GET /transcript?...&skip=sponsor,selfpromo` in one line.
- Attribution: every MCP and HTTP result that uses SponsorBlock data includes "Segment data: SponsorBlock (sponsor.ajay.app), CC BY-NC-SA 4.0". Note in your README that a paid hosted plan must not depend on this data (non-commercial license).
- Runtimes: pure fetch and WebCrypto (`crypto.subtle.digest`), so Node, Workers and browser.

## Prefer free and local

SponsorBlock is free and keyless. Nothing else is called.

## Out of scope

- LLM-based ad detection for non-YouTube videos (possible later; say so in the README, do not build it).
- Rendering in formats: item 01 renders whatever transcript it is given.

## Tests

- Record real API responses into `packages/skips/test/fixtures/` (document each in its README): a hash-prefix response that contains a popular tech-review video with sponsor and self-promotion segments (find one live; many large channels have them), a prefix response for a video with none, and a real 404. Also record that video's real transcript through the vid2context CLI (`--format json`) as a fixture, or use one from `tests/fixtures/contexts/` if a shared video has segments.
- Unit tests with `replayFetch`: prefix hashing, filtering to the exact video, category and vote filtering, overlap resolution, `full` and `poi` handling, `drop` and `mark` modes on the real transcript (assert the removed text really is the sponsor read), immutability of the input, the disable switch, timeout and 5xx mapping.
- LIVE test against the real API.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/skips` prints nothing; `npx vitest run packages/skips` passes; `npx biome check packages/skips` is clean.
- [ ] LIVE: for a real sponsored video, report the segments found and the first words of each removed sponsor read.

## Docs

- `packages/skips/README.md` (what, categories, license and attribution, env vars, how 44 and 46 mount it).
- Env vars in `.env.example` and `docs/providers.md` (a new "Content filters" table; your rows only). Data attribution entry in `THIRD_PARTY_NOTICES.md`.

## If credentials, tools or network are missing

No key is needed. If the API is unreachable, use the fixtures you recorded and report what is unverified live.

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
