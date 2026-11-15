# 59. Outbound webhooks and an n8n node

| | |
|---|---|
| Track | L. Reach (wave 2) |
| You own | `packages/webhooks/` (new package `@vid2context/webhooks`), `packages/n8n-nodes/` (new package `n8n-nodes-vid2context`) |
| Shared edits allowed | your rows in `docs/providers.md` and `.env.example`; `packages/core/src/storage-ext.ts` only as `docs/prompts/SHARED-CONTRACTS.md` section 1 allows; your entry in `THIRD_PARTY_NOTICES.md` if you copy code |
| Commit scope | `webhooks` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents. Watch lists (item 41) ingest new uploads automatically, jobs (42) finish in the background and briefs (32) take time. Other systems need to hear about it: a webhook when a collection gains a video lets a user wire vid2context into n8n, Zapier, Make or their own code ("new G-Wagon video, summarize it and message me"). Item 41 mentions webhooks for its own refresh only; nothing provides general, signed, retried webhooks or an automation-platform node.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `storage.ts`, `errors.ts`, `testing.ts`.
3. `docs/contracts/http-api.md`: conventions, jobs, and "Wave 2 routes" (`/webhooks*`).
4. The Standard Webhooks specification (standardwebhooks.com: `webhook-id`, `webhook-timestamp`, `webhook-signature`, the `whsec_` secret format and its published test vectors). n8n's docs for building community nodes (declarative or programmatic style, credentials, trigger nodes) and its current `n8n-workflow` types.
5. `docs/prompts/SHARED-CONTRACTS.md` sections 1 and 8; `docs/prompts/41-library-watch.md` and `42-jobs.md` to see what events they can emit.

## Goal

A user registers `https://example.com/hook` for `collection.updated`; when a watch list ingests a new video, that URL receives a signed Standard Webhooks request, retried with backoff if it fails. In n8n, the vid2context node fetches a transcript and the trigger node starts a workflow on vid2context events.

## Requirements

### Webhooks package

- Events: `video.ingested`, `collection.updated`, `job.succeeded`, `job.failed`, `brief.ready`. Payload `{ type, timestamp, data }` with the relevant ids, titles and URLs, never full transcripts (link to the API instead).
- `WebhookStore` on a `KvStore` (`storage-ext.ts`): `{ id, url, events, secret, createdAt, disabledAt?, failures }`. Secrets `whsec_` plus 24 random bytes, shown once.
- `emit(event, store, ctx)`: deliver to every subscriber with Standard Webhooks headers and signature (HMAC-SHA256, WebCrypto), 10 second timeout, retries on network errors, 5xx and 429 with exponential backoff and jitter (attempts at roughly 0 s, 30 s, 5 min, 30 min, 2 h, 8 h; on Workers schedule retries through the jobs package when present, otherwise run in-process with `setTimeout` and document that retries do not survive a restart). Disable a hook after 20 consecutive failures.
- SSRF protection: only `https:` (plus `http://localhost` when `VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL=1`), resolve-and-reject private, loopback and link-local ranges where the runtime allows DNS lookups (Node), and reject IP-literal private hosts everywhere. Use item 10's guard if it exports one when you finish.
- `src/http.ts`: `webhookRoutes(deps)` with `GET /webhooks`, `POST /webhooks`, `DELETE /webhooks/:id`, `POST /webhooks/:id/test` (sends a `test.ping`). Export `verifyWebhook(secret, headers, body)` for receivers.
- Emitters: export `webhookEmitter(store, ctx)` with an `on(event, data)` shape that 41, 42 and 32 can call; if any of them exposes an event hook when you finish, wire it; list the rest for the integration pass.

### n8n node (`packages/n8n-nodes/`)

- Credentials: base URL and API key. Node `vid2context` with operations Get Transcript, Get Metadata, Get Context, and (when the routes exist in `packages/server`) List Items and Add to Collection. Trigger node `vid2context Trigger` that registers a webhook through `POST /webhooks` on activation, deletes it on deactivation, and verifies signatures on receipt.
- Build to `dist/` with the n8n starter's conventions (this package is the one exception to source exports, because n8n loads compiled JS); document `npm run build` and how to install it into a local n8n.
- Zapier and Make: no app; document how to use their generic webhook catch and HTTP modules with the API and these webhooks.

## Prefer free and local

No services are required; n8n is free to self-host.

## Out of scope

- Inbound integrations (bots: item 56). A Zapier platform app.

## Tests

- Signing and verification against the Standard Webhooks published test vectors (document the source).
- Delivery tests against a real local HTTP server started in the test on a random port (a real receiver, not a fake fetch): success, 500 then success (retry), timeout, disable after failures, SSRF rejections.
- n8n node: unit-test the request building and the trigger's register and verify logic against a real vid2context server started in the test on a random port with recorded pipeline fixtures replayed underneath. If `n8n` can be run locally (`npx n8n`), load the built node LIVE and report.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/(webhooks|n8n-nodes)'` prints nothing; `npx vitest run packages/webhooks packages/n8n-nodes` passes; `npx biome check packages/webhooks packages/n8n-nodes` is clean.
- [ ] A test webhook signed by your code verifies with the official `standardwebhooks` npm library (dev dependency, verification only).

## Docs

- `packages/webhooks/README.md` (events, payloads, signing, retries, receiving), `packages/n8n-nodes/README.md`, a Zapier and Make section.
- Env vars in `.env.example` and `docs/providers.md` ("Webhooks" table; your rows only).

## If credentials, tools or network are missing

No key is needed. If n8n cannot run on the machine, report the node as built and unit-tested but not loaded live.

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
