# 54. Research tools: cited excerpts across videos, caption languages, key moments

| | |
|---|---|
| Track | J. Agent experience (wave 2) |
| You own | `packages/research/` (new package `@vid2context/research`) |
| Shared edits allowed | your entry in `THIRD_PARTY_NOTICES.md` if you copy code |
| Commit scope | `research` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents. Speech is about 12k tokens per hour, so dumping whole transcripts into an agent wastes its context. The most useful tool in popular YouTube MCP servers is a search that returns only the relevant excerpts with surrounding context and timestamp links: coyaSONG/youtube-mcp-server (MIT) reports far fewer characters than the full transcript with its `research-video(s)` tools. Wave 1's `search_transcript` (40, 44) searches the saved library; nothing searches a handful of videos on the fly. Two more tools that popular servers have and wave 1 lacks: listing caption languages before fetching (jkawamoto/mcp-youtube-transcript, MIT) and key moments.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `provider.ts` (`CaptionsProvider.listTracks`, `CaptionTrackInfo`), `pipeline.ts` (`getVideoContext`, `expandInput`, `chat`), `segments.ts`, `testing.ts`.
3. `providers/youtube/src/captions.ts` and `innertube.ts` (translation languages live in the player response).
4. `docs/contracts/mcp-tools.md` and `http-api.md`, "Wave 2" sections (`research_videos`, `list_caption_languages`, `get_key_moments`, `POST /research`, `GET /caption-languages`, `GET /key-moments`).
5. `docs/prior-art.md`; coyaSONG/youtube-mcp-server's research tools (MIT: you may port logic with attribution).
6. `docs/prompts/SHARED-CONTRACTS.md` sections 1 (`tokens.ts`) and 8.

## Goal

An agent asks "what do these five G-Wagon videos say about timing chains?" and gets back a few hundred tokens of ranked excerpts, each with its context and a timestamp link, instead of 90k tokens of transcripts.

## Requirements

### `research(inputs, query, opts, deps)` and `research_videos`

- Inputs: 1 to 10 URLs (a playlist URL expands through `expandInput`, capped at 10). Fetch contexts with `getVideoContext` (honour storage as a cache), in parallel with a limit of 3.
- Ranking: BM25 over sliding windows of segments (window about 30 seconds, stride half a window), with simple English stemming and stop words, and exact-phrase boost when the query is quoted. Port or write it in your package; do not depend on item 40's engine (it may not exist yet), but if `@vid2context/search` exports a compatible scorer when you finish, note it for the integration pass.
- Each excerpt: `startSec`, `endSec`, the matched text, `contextSec` (default 20) of text before and after, `[m:ss]`, the `timestampUrl`. Merge overlapping windows. `maxExcerpts` per video (default 3), and a global token cap (default 2000 tokens) with a note when results were cut.
- When nothing matches lexically, say so plainly and suggest synonyms the agent could try; do not fall back to an LLM.

### `listCaptionLanguages(url)` and `list_caption_languages`

- From the captions provider's `listTracks` plus YouTube's translation targets (add a small exported reader for `translationLanguages` in your package from the player response if the YouTube provider does not export one; never edit `providers/youtube`). Non-YouTube sources: tracks only.

### `keyMoments(url, count)` and `get_key_moments`

- Uses the LLM chain (`chat` from core, JSON mode) on a compact timestamped transcript (chunked if longer than the rung's `contextTokens`, then merged). Ask for `{ startSec, title, why }`. Validate every `startSec` against real segments (snap to the nearest segment start within 5 seconds, drop otherwise) and say how many were dropped. Result includes the rung used and its attempts.

### Package shape

- `src/index.ts` (the functions), `src/mcp.ts` (`registerResearchTools(server, deps)`), `src/http.ts` (`researchRoutes(deps)`). Runtime-neutral: Node, Workers, browser.

## Prefer free and local

Research and languages need no LLM. Key moments use the chain, so local, then free, then keyless rungs.

## Out of scope

- Library-wide search and embeddings: items 40 and 29. Frames at a timestamp: item 31 (visual notes owns frames).

## Tests

- Real data: `tests/fixtures/contexts/*.json` served from a pre-filled `MemoryStorage`. Query for words that really occur in the G-Wagon transcript (for example a model name or "engine") and assert ranking order, merging, context bounds, citation URLs and the token cap.
- `list_caption_languages`: replay the real player fixtures in `providers/youtube/test/fixtures/` (read-only).
- Key moments: record the real keyless chain response for your exact prompt on the shared G-Wagon transcript (`LIVE=1` once, saved as a fixture and documented), then assert timestamp validation on it.
- MCP tools over `InMemoryTransport` and HTTP routes through `app.request`.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/research` prints nothing; `npx vitest run packages/research` passes; `npx biome check packages/research` is clean.
- [ ] LIVE: `research_videos` on three real videos from the G-Wagon playlist (`PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b`) for a real buying question; paste the result size in tokens versus the full transcripts.

## Docs

- `packages/research/README.md`: the three tools, ranking, limits, mounting by 44 and 46.

## If credentials, tools or network are missing

No key is needed. If YouTube blocks the machine, use the shared contexts and report it.

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
