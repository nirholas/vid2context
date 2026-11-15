# 17. Speech-to-text: more OpenAI-compatible rungs

| | |
|---|---|
| Track | D. Speech-to-text |
| You own | `providers/stt-openai-compatible/` (exists from the foundation; extend it) |
| Shared edits allowed | Your own rows in `docs/providers.md` and variables in `.env.example` |
| Commit scope | `stt` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. When a video has no captions, its audio goes through a free-first chain of speech-to-text rungs. The foundation ships four OpenAI-compatible rungs (a generic local server, Groq, OVH keyless and OpenAI). More hosted options mean more free quota before anything paid runs, and better requests (word timestamps, prompts that teach the model names and jargon from the video's metadata) mean better transcripts for the same cost. This prompt widens the chain and sharpens every request, without changing the provider's contract.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`AudioInput`, `Segment`), `packages/core/src/provider.ts` (`SttRung`, `SttOptions`, `rungs(env)`), `packages/core/src/keys.ts` (`keyPool`, `pooledService`), `packages/core/src/chain.ts` (cooldowns, `retryAfterSec`), `packages/core/src/errors.ts` (`errorFromResponse`), and `packages/core/src/testing.ts`.
3. All of `providers/stt-openai-compatible/` (`src/index.ts`, `src/client.ts`, `src/languages.ts`, tests and fixtures).
4. `docs/contracts/providers.md` (rung fields, capability vocabulary for stt: `segments`, `words`, `language-detect`, `prompt`, `diarization`, `translate`; env conventions) and `docs/providers.md` (the speech-to-text table).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7, 8 and 9.

## Goal

The provider offers every OpenAI-compatible speech-to-text service you could verify today, each as its own rung with correct limits and env overrides, with key pools, word timestamps where supported, metadata-based prompt biasing, and rate-limit headers feeding the chain's cooldowns. Existing rungs keep their ids and behaviour.

## Requirements

### New rungs (verify each before adding)

- For every candidate, read the service's current API docs (WebFetch) for the endpoint, model ids, file size limit, accepted formats, response formats and free allowance, and call it live when a key is available. Add only services whose OpenAI-compatible `/audio/transcriptions` endpoint you verified. Candidates: Fireworks (`whisper-v3`, `whisper-v3-turbo`; note its audio base URL may differ from its chat base URL), DeepInfra (`openai/whisper-large-v3-turbo`), SambaNova Cloud (Whisper, if still offered), plus presets on the existing generic local rung for speaches, faster-whisper-server and LocalAI (documented `LOCAL_STT_BASE_URL` values, default ports, recommended models).
- Keep Groq (free), OVH (keyless) and OpenAI (paid) exactly as they are, including ids like `stt/ovh/whisper-large-v3-turbo`.
- Per service: tier (`free` for a hosted free tier or sign-up credits with the user's key, `paid` otherwise), priority (gaps of 10), quality, `maxBytes`, capabilities, `requires`, `<PROVIDER>_STT_MODEL` override, `<PROVIDER>_BASE_URL` where it can be proxied, and key pools through `keyPool(env, '<PROVIDER>_API_KEY')` with `pooledService` (one rung per key).

### Better requests

- Word timestamps: when a service supports `timestamp_granularities[]=word` (with `verbose_json`), request words, and attach them to segments (add the `words` capability). Keep segment timestamps as the primary output.
- Prompt biasing: use `SttOptions.prompt` when given; document that the pipeline (or a later integration) should fill it from metadata (title, channel name, chapter titles, keywords), and export a helper `promptFromMetadata(metadata, maxChars = 800)` that builds it. Respect each service's prompt length limit.
- Language: pass `SttOptions.language` normalized with the existing `normalizeLanguage`; report detected language.
- Response variants: normalize `verbose_json`, `json` and `text` responses (some services ignore `verbose_json`), so a service without segments still yields one segment spanning the known duration, marked by the absence of the `segments` capability on that rung.
- Upload hygiene: a filename with a real audio extension (OVH rejected `.out`), correct `Content-Type`, and `AudioInput` of kind `url` downloaded through `ctx.fetch` with a size cap when a service cannot fetch URLs itself.

### Rate limits and errors

- Read `retry-after` and `x-ratelimit-*` headers (remaining requests, reset) into `retryAfterSec` on the thrown `Vid2ContextError`, so the chain's cooldown is accurate. OVH keyless allows about 2 requests per minute per IP: make sure its 429 cooldown honours that.
- Map service-specific error bodies (file too large, unsupported format, model not found) to `too-large`, `bad-request` (only for real input errors), `not-found` and `upstream` with hints.

## Prefer free and local

Order stays local, then free (Groq first, then other free tiers by quality and limits), then keyless OVH, then paid. Document which services give a real free tier and which only give sign-up credits, and rank credits-only services after true free tiers.

## Out of scope

- whisper.cpp: prompt 18. Transformers.js: prompt 19. Workers AI: prompt 20. Deepgram and AssemblyAI diarization: prompt 22. Gemini audio: prompt 30.
- The Whisper repetition-loop guard: prompt 02 (caption cleanup) applies it in the pipeline.
- Splitting long audio: prompt 04.

## Tests

- Record real responses for every service you add into `providers/stt-openai-compatible/test/fixtures/`, transcribing the shared `tests/fixtures/media/apollo11-small-step.mp3`: success (`verbose_json`, with words where supported), a real 429 with its headers, and a real error for an oversize or bad file where you can trigger one cheaply. Strip anything personal and document each file.
- Assert through `replayFetch`: the multipart request (fields, filename extension, no `Authorization` header to keyless OVH), response normalization to segments and words, `retryAfterSec` from headers, error mapping, pooled rungs (ids, services `groq`, `groq#2`), env model overrides, and that existing rung ids are unchanged.
- LIVE: transcribe the Apollo clip through every rung whose key is set, and through OVH keyless; assert the text contains "small step".

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/stt-openai-compatible'` prints nothing.
- [ ] `npx vitest run providers/stt-openai-compatible` passes; `npx biome check providers/stt-openai-compatible` is clean.
- [ ] `GET /api/v1/health` (or `registry.health(env)`) lists every new rung, disabled with its `requires` when no key is set.
- [ ] `npm run test:live -- providers/stt-openai-compatible` passes for OVH and for every service with a key, or the report lists which were not run.
- [ ] Every service in the provider is backed by a recorded real response or a LIVE pass; none was added from documentation alone without saying so in the report.

## Docs

- Your rows in `docs/providers.md` (rung id, tier, env vars, free limits with the date checked) and your variables in `.env.example`.
- `docs/guides/speech-to-text.md`: a decision table (privacy, cost, speed, file limits, word timestamps) across every speech-to-text option in the repo, with links to the other speech-to-text prompts' guides by file name.

## If credentials, tools or network are missing

OVH keyless needs no key: verify against it live. For services without a key, add them only if you can still verify the request format against current official docs, mark them unverified in `docs/providers.md`, and list them in the report; do not fabricate fixtures for them.

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
