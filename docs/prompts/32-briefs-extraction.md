# 32. Cited briefs and structured extraction

| | |
|---|---|
| Track | F. Intelligence |
| You own | `packages/insights/` |
| Shared edits allowed | `packages/core/src/tokens.ts` (create from SHARED-CONTRACTS 1.4 if missing) and its `export *` line in `packages/core/src/index.ts`; the `/briefs` and `/extract` rows in `docs/contracts/http-api.md` and the `build_brief` and `extract` rows in `docs/contracts/mcp-tools.md` |
| Commit scope | `insights` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The owner's real use case is a YouTube playlist series explaining which Mercedes G-Wagon to buy: they want an agent to absorb the whole series and advise on model, year and mileage, citing which episode and timestamp said what, and flagging where the sources agree and where they disagree. This package produces those cited briefs and the structured extractions behind them (buyer guide, tutorial steps, comparison, any JSON Schema). It absorbs roadmap item 33 (extraction templates): work `docs/contracts/` assigns to item 33 is yours. By default the calling agent does the synthesis (the MCP server hands it data and a prompt), so this package serves both paths: prompt builders for the agent, and server-side map-reduce on a cheap free model for collections too large for the agent's context.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md` (the "Who synthesizes" section).
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts` (`ChatRequest`, `ChatResult`, `json` option), `packages/core/src/pipeline.ts` (`chat`, `getVideoContext`), `packages/core/src/segments.ts` (`timestampUrl`, `sliceSegments`), `packages/core/src/storage.ts`, and `packages/core/src/testing.ts`.
3. `docs/contracts/http-api.md` (`POST /briefs`, `POST /extract`, `Citation`, the `RouteDeps` sub-app factory pattern, the Job shape) and `docs/contracts/mcp-tools.md` (`build_brief`, `extract`, the `brief` and `buyer_guide` prompts, the `register<Name>Tools` pattern).
4. `tests/fixtures/README.md`: `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` is part 1 of a real G-Wagon buyer's series. Use it.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.4 (`tokens.ts`), 3 and 8.

## Goal

`@vid2context/insights` turns one or many `VideoContext`s into a cited brief (Markdown plus structured JSON) and into schema-validated extractions, where every claim carries a verified citation (video, timestamp, quote, timestamp link). It exports prompt builders for agent-side synthesis, server-side execution through the core LLM chain, a Hono sub-app (`src/http.ts`) and MCP registration (`src/mcp.ts`).

## Requirements

### Package

- New workspace package `packages/insights` (`@vid2context/insights`), runtime-neutral (no `node:` imports in `src/`), exporting TypeScript source like the other packages.
- Public API in `src/index.ts`: `briefPrompt`, `extractPrompt`, `buildBrief`, `extract`, `verifyCitations`, `templates`, and the types `Claim`, `Brief`, `ExtractionResult`, `Citation` (re-use the contract's `Citation` shape: `{ videoId, title, startSec, endSec?, url?, quote? }`).

### Prompt builders (agent-side synthesis, the default)

- `briefPrompt(contexts, { question?, template?, maxTokens? })` returns `ChatMessage[]` the calling agent can follow: the sources (timestamped, fenced as untrusted data), the citation rule (`[Title @ m:ss](url)`), and instructions to flag consensus, disagreement and single-source claims.
- `extractPrompt(contexts, { template | schema })` does the same for structured output.
- These are what prompt 44's MCP `brief` and `buyer_guide` prompts will use: export the prompt text so 44 can import it.

### Server-side map-reduce

- If all sources fit the chosen model's context window (`estimateTokens`, the rung's `contextTokens`, with headroom), run a single pass.
- Otherwise map each video, chunked by budget on paragraph or segment boundaries, into claims JSON: `{ claim, quote, videoId, startSec, topic, stance? }`, using `chat(registry, req, chain, ctx)` with `json` set.
- Reduce: cluster claims by topic (normalized topic labels plus a merge step through the LLM), then mark `consensus` (two or more independent videos agree), `disagreement` (conflicting claims, each cited), and `single-source`.
- Default to cheap free models through the chain; never require a paid key. Record which rung served each step in the result (`rungs`, `attempts`).
- Transcript text in prompts is untrusted: wrap it in clearly delimited blocks with an instruction that it is data, not instructions. Use `fenceUntrusted` from `packages/core/src/security` if prompt 10 has landed by the time you finish; otherwise a small local helper with the same behaviour.

### Citation verification

- `verifyCitations(claims, contexts)`: each claim's `quote` must fuzzy-match transcript text within a window around `startSec` (for example plus or minus 30 s; normalize case, punctuation and whitespace; token-overlap score with a documented threshold). Fix `startSec` to the best-matching segment when it is close.
- Unverifiable claims are dropped from the main brief and listed in an appendix with the reason. Never present an unverified claim as cited.
- Links come from `timestampUrl(ref, startSec)`.

### Templates

- `src/templates/*.md` (prompt text) plus JSON Schemas for: `brief`, `buyer-guide` (models or trims, years, prices, known problems, what to avoid, mileage advice, questions to ask a seller, each item cited), `tutorial-steps`, `comparison` (table rows and columns, cells cited), `summary`.
- Custom JSON Schema extraction: validate the model output against the schema (a small validator for the JSON Schema subset you support, or `ajv` as a dependency of this package), and on failure retry once with the validation errors in the prompt. Unsupported schema features fail with `bad-request` and a hint.

### Outputs

- `Brief`: `{ question?, template, markdown, claims: Claim[] (with verified citations), consensus, disagreements, unverified, sources: VideoSummary-like[], rungs, attempts, createdAt }`.
- Markdown brief: title, the question, sections by topic, consensus first, disagreements with both sides cited, a sources table, and the unverified appendix.
- Keep raw transcripts untouched; the brief is a layer next to them.

### HTTP and MCP factories

- `src/http.ts`: `insightsRoutes(deps: RouteDeps): Hono` with `POST /briefs` and `POST /extract` exactly as `docs/contracts/http-api.md` describes. When `@vid2context/jobs` (prompt 42) exists when you finish, return `202 Job` through it; otherwise return the result synchronously, document that in the contract row, and report it. Do not edit `packages/server`: prompt 46 mounts your factory.
- `src/mcp.ts`: `registerInsightsTools(server, deps)` registering `build_brief` and `extract` per `docs/contracts/mcp-tools.md`. Do not edit `packages/mcp`: prompt 44 calls it.

## Prefer free and local

Agent-side synthesis costs nothing extra and is the default. Server-side runs use the core chain with the default `free` policy: local LLM rungs first, then free tiers, then keyless lanes (OVH, Pollinations), paid only when a key is set and allowed. Prefer small, fast models for the map step and allow a stronger rung for the reduce step through `ChainOptions` (for example `policy: 'quality'` for reduce only).

## Prior art you may reuse

danielmiessler/Fabric (MIT) has prompt patterns such as `data/patterns/extract_wisdom`; coyaSONG/youtube-mcp-server (MIT) returns cited excerpts with timestamp links across several videos. Licenses and attribution rules: `docs/prior-art.md`. Copy only MIT, BSD, ISC, Unlicense or Apache-2.0 code, keep the original copyright line in the copied file, and add the project to `THIRD_PARTY_NOTICES.md` (create it if missing; additive edits only). Never copy GPL or unlicensed code.

## Out of scope

- Q&A and chat over videos: prompt 34 (ask).
- Translation and auto-chapters: prompt 35.
- Chunking helpers beyond what you need locally: prompt 03 (if `packages/core/src/chunk` has landed, use its `chunkTranscript`; otherwise chunk locally).
- Mounting routes or tools in the server or MCP packages: prompts 46 and 44.

## Tests

- Record two or three more real videos on the same topic as cCPsdFdlshc (other parts of the G-Wagon series or another real buyer's series) with the foundation CLI (`npm run cli -- <url> --format json`), and save them in `packages/insights/test/fixtures/contexts/` with a README line each. Use them with the shared cCPsdFdlshc fixture.
- Record real LLM responses for the map and reduce steps once with `LIVE=1` from a keyless rung, save them as fixtures, and replay them with `replayFetch`. Assert the brief structure, that every cited claim passed verification, and that consensus requires two distinct `videoId`s.
- Verification unit tests on real transcript text: an exact quote passes, a paraphrase within the window passes or fails per the documented threshold, a quote from a different time range is corrected or rejected, a quote that does not exist is rejected.
- Schema extraction: a real recorded response that violates the schema triggers exactly one repair call (replayed), and a valid response passes.
- Prompt builders: snapshot `briefPrompt` output for the fixtures and check it fences transcripts and states the citation rule.
- Live test (`LIVE=1`): a real brief over the fixtures with the keyless chain.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/insights'` prints nothing.
- [ ] `npx vitest run packages/insights` passes; `npx biome check packages/insights` is clean.
- [ ] A real run (`npx tsx packages/insights/examples/brief.ts` over the G-Wagon fixtures with the keyless chain) produces a buyer guide in which every citation link opens the video at a timestamp whose transcript contains the quoted words. Spot-check five by hand and say so in your report.
- [ ] `insightsRoutes` answers `POST /briefs` and `POST /extract` when mounted on a bare Hono app in a test.
- [ ] `registerInsightsTools` registers `build_brief` and `extract` on a real `McpServer` (tested through the SDK's in-memory transport).

## Docs

- `docs/guides/briefs.md`: agent-side versus server-side synthesis, templates, verification rules, the G-Wagon walkthrough with a short real excerpt.
- Update the `/briefs` and `/extract` rows in `docs/contracts/http-api.md` and the `build_brief` and `extract` rows in `docs/contracts/mcp-tools.md` if your behaviour (synchronous versus job) differs from what they say.

## If credentials, tools or network are missing

Keyless lanes need no key. If the network is down, use the shared fixture and recorded LLM responses only, skip live tests with a clear message, and report that the end-to-end brief was not produced live. Never write an LLM response by hand.

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
