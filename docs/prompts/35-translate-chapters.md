# 35. Translation and auto-chapters

| | |
|---|---|
| Track | F. Intelligence |
| You own | `packages/translate/`, `packages/chapters/` |
| Shared edits allowed | `packages/core/src/tokens.ts` (create from SHARED-CONTRACTS 1.4 if missing) and its `export *` line in `packages/core/src/index.ts`; the translation and `/chapters` rows in `docs/contracts/http-api.md` |
| Commit scope | `translate` or `chapters` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Two enrichments make long or foreign-language videos usable by agents: translation (a German review read as English) and chapters (a 40-minute video with no chapters becomes navigable, so an agent can fetch one section instead of 8k tokens). This prompt covers roadmap items 35 (translation) and 36 (auto-chapters): work `docs/contracts/` assigns to item 36 is yours. Both are layers next to the raw transcript, never replacements.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`Transcript.translated`, `Chapter`, `VideoMetadata.chapters`), `packages/core/src/provider.ts` (`CaptionOptions.allowTranslated`, `ChatRequest`), `packages/core/src/pipeline.ts` (`getVideoContext` with `language`, `chat`), `packages/core/src/segments.ts`, and `packages/core/src/testing.ts`.
3. `providers/youtube/src/captions.ts` (how `tlang` translated tracks are chosen today).
4. `docs/contracts/http-api.md`: `GET /transcript?...&lang=xx&translate=1` (a route prompt 46 owns; you export the function it calls) and `POST /chapters` (yours, through `src/http.ts`), plus the `RouteDeps` sub-app pattern.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.4 and 8. `tests/fixtures/README.md`.

## Goal

`@vid2context/translate` exports `translateContext(registry, context, { language, glossary? }, ctx)` that prefers a platform translation and falls back to chunked LLM translation that preserves every segment and timestamp. `@vid2context/chapters` exports `autoChapters(registry, context, opts, ctx)` that proposes valid chapters offline with a TextTiling-style algorithm and optionally titles and refines them with an LLM, plus a Hono sub-app with `POST /chapters`.

## Requirements

### Translation (`packages/translate`)

- Order: (1) if the context's source has platform captions in the target language or a platform machine translation (YouTube `tlang`), get it through `getVideoContext(registry, input, { language, refresh: true }, ctx)` and accept it when `transcript.language` matches; (2) otherwise translate with the LLM chain.
- LLM translation: chunk segments by token budget (`estimateTokens`), send each chunk as a JSON array of `{ id, text }` and require a JSON array back with the same ids; verify the count and ids, retry the chunk once with the error, and on a second failure keep the original text for that chunk and record it in a report. Keep `startSec`, `endSec`, `speaker` from the source segments.
- Glossary: names, product and model terms kept as given (passed in, plus automatically the channel name and capitalized terms that repeat in the title and description).
- Result: a new `Transcript` with `language` set to the target, `translated: true`, `producer` (rung id or caption provider id), `model`, and the original kept by the caller. Never overwrite the stored raw transcript.
- Source text in prompts is untrusted: fence it as data (use `fenceUntrusted` from prompt 10 if `packages/core/src/security` exists when you finish, else a local helper).
- Export `translateContext` for prompt 46's `translate=1` handling; do not edit `packages/server`.

### Auto-chapters (`packages/chapters`)

- Offline segmentation (no LLM, runtime-neutral): a TextTiling-style lexical cohesion algorithm over sliding windows of transcript tokens (stopword list per language for en at least, depth scores, smoothing, boundary selection), snapping boundaries to segment starts.
- Validation of any chapter list: first chapter at 0, strictly ascending, minimum length (default 60 s), count scaled to duration (roughly one per 3 to 8 minutes, configurable), `endSec` filled, final chapter ends at the duration.
- Optional LLM step: given the offline boundaries and the text of each section, propose a short title per chapter and allow moving each boundary within a small window (snap to a segment start), returning JSON validated against the rules above; fall back to offline boundaries with titles from the most distinctive terms when the LLM fails.
- Optional per-chapter summaries (one or two sentences each) behind a flag.
- Output: `{ chapters: Chapter[], producer, rung?, source: 'auto' }`. Mark the source in metadata `extra.chapterSource = 'auto'` when callers store it. Only apply to videos without chapters unless `force` is set.
- `src/http.ts`: `chaptersRoutes(deps: RouteDeps): Hono` with `POST /chapters` per the contract (`{ url }` to `{ chapters, producer, rung }`). Prompt 46 mounts it.

## Prefer free and local

Translation: platform captions or YouTube's own translation first (free, no model), then local LLM rungs, then free tiers, then keyless lanes. Auto-chapters: the offline algorithm needs nothing; the LLM titling step uses the cheapest enabled rung.

## Out of scope

- YouTube caption track selection itself: prompt 06.
- Formatting chapters into Markdown or the context pack: prompt 01.
- Surfaces (CLI flags, MCP tools, the `/transcript` route): prompts 43, 44, 46.

## Tests

- Real fixtures: `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (18 minutes, no chapters: the main chapters test), `youtube-jNQXAC9IVRw.json` (has en and de tracks on YouTube).
- Translation: record a real YouTube `tlang` caption response (or reuse `providers/youtube/test/fixtures/` where it fits) and real LLM translation responses from a keyless rung with `LIVE=1`; replay them. Assert segment count and timings are preserved, ids verified, a recorded response with a missing id triggers exactly one retry, and the original transcript object is untouched.
- Auto-chapters: run the offline algorithm on the long fixture and assert validity (starts at 0, ascending, minimum length, count in range, covers the duration) and stability (same output on rerun), not exact positions. LLM titling with a recorded real response.
- `POST /chapters` through `chaptersRoutes` mounted on a bare Hono app with replayed responses.
- Live tests (`LIVE=1`): translate a short real video to another language; auto-chapter a real video without chapters.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/(translate|chapters)'` prints nothing.
- [ ] `npx vitest run packages/translate packages/chapters` passes; `npx biome check packages/translate packages/chapters` is clean.
- [ ] A real auto-chapter run on the G-Wagon fixture gives chapters a human would accept (paste them in your report).
- [ ] A real translation keeps every timestamp and reads correctly in the target language (spot-check in your report).

## Docs

- `docs/guides/translate-and-chapters.md`: the order of attempts, glossary, the TextTiling approach in plain words, validation rules, examples from real output.
- Keep the translation and `/chapters` rows in `docs/contracts/http-api.md` accurate.

## If credentials, tools or network are missing

The offline chapters algorithm needs nothing. Keyless rungs need no key. Without network, run the replayed tests only, skip live tests with a message, and report what was not verified. Never hand-write a translation or an LLM response.

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
