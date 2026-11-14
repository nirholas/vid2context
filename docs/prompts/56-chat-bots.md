# 56. Chat bots: Telegram, Discord and Slack

| | |
|---|---|
| Track | L. Reach (wave 2) |
| You own | `packages/bots/` (new package `@vid2context/bots`) |
| Shared edits allowed | your rows in `docs/providers.md` and `.env.example`; your entry in `THIRD_PARTY_NOTICES.md` if you copy code |
| Commit scope | `bots` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents. A lot of research happens in chat apps: someone drops a video link in a group and wants the gist. A bot that answers a link with a short, timestamp-cited summary and attaches the full transcript makes vid2context useful where people already are, with no install. No wave-1 prompt covers bots. All three platforms deliver events to a webhook, so the bots are Hono routes that run on the same server or Cloudflare Worker as the API.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/pipeline.ts` (`getVideoContext`, `chat`), `segments.ts`, `errors.ts`, `testing.ts`; `packages/server/src/app.ts` (`createApp`, error handling).
3. `docs/contracts/http-api.md`, "Wave 2 routes" (`/bots/*`).
4. Current official docs: Telegram Bot API (webhooks, `secret_token`, `sendMessage`, `sendDocument`), Discord interactions (Ed25519 request verification, deferred responses, followup webhooks, application commands), Slack (request signing, Events API, slash commands, `chat.postMessage`, the files upload v2 flow). Verify every endpoint and header live in the docs.
5. `docs/prompts/SHARED-CONTRACTS.md` section 8.

## Goal

With tokens configured, sending a YouTube link to the Telegram bot, using `/video <url>` in Discord, or `/vid2context <url>` in Slack produces a reply with the title, a 5 to 8 bullet summary where each bullet cites `[m:ss]` links, and the transcript attached as a text file.

## Requirements

- `botsRoutes(deps: { registry, makeCtx, waitUntil?: (p: Promise<unknown>) => void })` in `src/http.ts`: `POST /bots/telegram`, `POST /bots/discord`, `POST /bots/slack/events`, `POST /bots/slack/commands`. A platform whose secrets are unset answers 404 (the route is effectively off).
- Verification first, before parsing: Telegram `X-Telegram-Bot-Api-Secret-Token` equals `TELEGRAM_WEBHOOK_SECRET` (constant-time compare); Discord Ed25519 over timestamp plus body with `DISCORD_PUBLIC_KEY` (WebCrypto `Ed25519`; check Node 22 and Workers support it and report); Slack `v0` HMAC-SHA256 with `SLACK_SIGNING_SECRET`, rejecting timestamps older than 5 minutes; Slack `url_verification` handled. Reject with 401 and no detail.
- Respond within platform deadlines: Discord defers (type 5) then edits the original response through the followup webhook; Slack acks immediately, then posts. Background work runs through `deps.waitUntil` (Workers `executionCtx.waitUntil`) or a tracked promise on Node; never lose errors (log through `ctx.log` and tell the user what failed, with the error hint).
- Summary: `chat()` from core with a system prompt demanding bullets that end in `[m:ss]`; validate timestamps against segments (drop invalid ones). Links use `timestampUrl`. Telegram and Slack messages use each platform's formatting rules (escape Telegram MarkdownV2 or use HTML parse mode; Slack mrkdwn). Long transcripts go as a `.txt` attachment.
- Abuse: per-chat and per-user rate limits (default 10 requests per hour) held in memory per instance, plus an allowlist option (`BOTS_ALLOWED_CHATS` for Telegram chat ids, `BOTS_ALLOWED_GUILDS`, `BOTS_ALLOWED_TEAMS`). Only video inputs are accepted: never local paths (the media-file source must not be reachable from a bot; reject inputs whose resolved platform is `file`).
- Setup scripts in `packages/bots/scripts/`: register the Telegram webhook (`setWebhook` with the secret), register Discord slash commands, print the Slack app manifest with the right URLs. They read keys from the environment and print what they did, never the keys.
- Env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `BOTS_PUBLIC_BASE_URL`, the allowlists.
- Runtimes: Node and Workers (fetch, WebCrypto only).

## Prefer free and local

All three platforms are free for bots. Summaries use the free-first LLM chain.

## Out of scope

- Mounting in `packages/server` (item 46 or the integration pass). WhatsApp (needs a paid Meta business setup).

## Tests

- Signature verification: use the platforms' published verification test vectors where they exist (document the source of each in `test/fixtures/README.md`). Where none exist, generate a real key pair in the test and sign a real recorded request body. Payload bodies must be real: copy the example payloads from the official docs (cite the URL) or record your own if you can set up a bot.
- Route tests through `app.request` with the full pipeline replayed from recorded fixtures (the shared YouTube fixtures and recorded keyless LLM responses for your exact summary prompt, recorded once with `LIVE=1`).
- Cover: rejected bad signatures, stale Slack timestamps, Discord PING, deferred flow, rate limiting, `file` inputs rejected, platform off when unconfigured.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/bots` prints nothing; `npx vitest run packages/bots` passes; `npx biome check packages/bots` is clean.
- [ ] If any bot token is available in the environment, run that bot end to end through a tunnel or the deployed Worker and report it; otherwise report that live delivery is unverified.

## Docs

- `packages/bots/README.md`: setup for each platform step by step, env vars, limits, privacy (what is logged, what is not).
- Env vars in `.env.example` and `docs/providers.md` ("Bots" table; your rows only).

## If credentials, tools or network are missing

Without bot tokens, build and test everything against recorded and documented payloads, and report that live delivery was not verified.

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
