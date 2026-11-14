# 62. Duplicate, reupload and clip detection

| | |
|---|---|
| Track | K. Content quality (wave 2) |
| You own | `packages/dedupe/` (new package `@vid2context/dedupe`) |
| Shared edits allowed | your entry in `THIRD_PARTY_NOTICES.md` if you copy code |
| Commit scope | `dedupe` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents, and its briefs flag consensus and disagreement between sources. That only works if sources are independent. YouTube is full of reuploads, re-edits and clips of the same original ("Doug DeMuro says buy a G-Wagon" is a clip of a longer show). If a brief counts the original and three clips as four sources agreeing, the consensus is fake. No wave-1 prompt detects this.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`VideoContext`, `Segment`), `segments.ts`, `storage.ts`, `testing.ts`.
3. `docs/contracts/mcp-tools.md` and `http-api.md`, "Wave 2" (`find_duplicates`, `POST /duplicates`).
4. `docs/prompts/32-briefs-extraction.md` (how briefs will consume your groups) and `docs/prompts/SHARED-CONTRACTS.md` section 8.

## Goal

Given the contexts of a collection, `findDuplicates(contexts)` returns groups such as "these two are the same video (reupload)" and "this 3-minute video is a clip of that 40-minute video starting at 12:31", with evidence, so item 32 can count each original once.

## Requirements

- Normalization: lowercase, strip punctuation and filler, collapse whitespace, map numbers to digits; word shingles of size 5 over the whole transcript with positions kept (time of each shingle).
- Candidate search: MinHash (128 hashes, seeded, deterministic) plus LSH banding to avoid comparing every pair; then exact shingle overlap on candidates.
- Classification: `reupload` when both transcripts overlap above 0.8 of the shorter and durations are within 10 percent; `clip` when the shorter's shingles mostly (above 0.6) appear in the longer in time order, with the offset estimated from matched shingle times (median of differences) and the covered range; `related` (shared passages but neither) reported separately with the shared spans; otherwise distinct. Thresholds configurable, defaults documented with the reasoning.
- Auto-captions differ word by word between uploads; make matching tolerant (shingles on a normalized vocabulary, allow small gaps) and measure it on the real fixtures below rather than guessing.
- Metadata signals as tie-breakers only (title similarity, same channel, publish dates: the earliest is the likely original). Never classify on metadata alone.
- API: `findDuplicates(contexts, opts?)` returning `{ groups: { kind, members: { videoId, offsetSec?, coveredRange? }[], original?: videoId, evidence: { overlap, matchedShingles, method } }[] }`; `independentSources(contexts)` returning one representative per group for item 32. Pure and runtime-neutral (no network, no Node built-ins), fast enough for 200 one-hour transcripts on a laptop (measure and report).
- `src/mcp.ts`: `registerDedupeTools(server, deps)` with `find_duplicates { urls?, collection? }`. `src/http.ts`: `dedupeRoutes(deps)` with `POST /duplicates`.

## Prefer free and local

Purely local computation.

## Out of scope

- Audio or visual fingerprinting (transcripts suffice for this use case; say so). Changing briefs: item 32 consumes your output.

## Tests

- Real fixtures recorded with the vid2context CLI (`--format json`) into `packages/dedupe/test/fixtures/`, documented with source URLs: an original and at least one real reupload of it (for example "Me at the zoo" has many reuploads on YouTube; find one with captions or auto-captions), and a real long video plus a real clip of it (find a show clip channel that posts excerpts of a full episode that is also on YouTube). Use the two shared contexts in `tests/fixtures/contexts/` as distinct-video negatives.
- Assert classification, the clip offset (within a few seconds of the true offset, which you determine by listening or by matching text manually and recording the evidence in the fixture README), and that distinct videos are never grouped. Determinism test (same input, same output). A performance test on the real fixtures scaled by repetition, with a generous bound.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/dedupe` prints nothing; `npx vitest run packages/dedupe` passes; `npx biome check packages/dedupe` is clean.
- [ ] Report the measured overlap scores for each fixture pair and why the default thresholds sit where they do.

## Docs

- `packages/dedupe/README.md`: method, thresholds, limitations (re-dubbed or translated reuploads are not detected), how item 32 should use `independentSources`.

## If credentials, tools or network are missing

No key is needed. If YouTube blocks the machine before you can record a reupload and a clip, report it: do not construct transcripts by editing real ones.

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
