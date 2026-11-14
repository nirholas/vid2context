# vid2context: rules for agents

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs. TypeScript, ESM, npm workspaces, free first. It is a standalone project: it has nothing to do with three.ws, sperax, Solana or any token, and no rules from those repos apply here.

Read before changing code: this file, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [packages/core/src/types.ts](packages/core/src/types.ts), [packages/core/src/provider.ts](packages/core/src/provider.ts) and the contract for your area in [docs/contracts/](docs/contracts/).

## Commands

```sh
npm install          # installs and generates the provider registries
npm run check        # typecheck + lint + test; run before every commit
npm run typecheck    # tsc (regenerates the registries first)
npm run lint         # Biome; npm run format applies fixes
npm test             # vitest on recorded fixtures, no network
npm run test:live    # LIVE=1: also runs tests against the real services
npm run gen          # regenerate packages/registry/src/generated/
npm run cli -- <url> [--format text|json] [--timestamps] [--mode auto|captions|stt|video] [--lang xx]
npm run mcp          # stdio MCP server
npm run dev:server   # HTTP API on 127.0.0.1:8787 with reload
npm run build:npm    # bundle the npm packages vid2context-mcp and vid2context
npm run discovery:gen  # regenerate server.json and the other directory manifests
```

Node 22 or newer. Keys go in `.env` (see `.env.example`); every key is optional.

## House style

- Never use the em-dash or en-dash characters. Use commas, colons, periods or parentheses. In code that must match those characters, write the escapes `\u2013` and `\u2014`.
- Keep replies and docs short and plain. No emojis.
- No mocks, fake data, placeholders, TODOs or stub functions, in code or tests. If something cannot be built yet, leave it out and say so.
- Explain choices in plain language.

## Code rules

- Packages export TypeScript source (`"exports": { ".": "./src/index.ts" }`). Import with explicit `.ts` extensions.
- Providers never read `process.env` or use the global `fetch`: use the `ctx` passed to every call (`ctx.env`, `ctx.fetch`, `ctx.log`, `ctx.signal`).
- stdout is for program output and the MCP stdio protocol only. Log to stderr (`ctx.log`, or `console.error` in entry points).
- Prefer plain `fetch` to vendor SDKs; most AI APIs are OpenAI-compatible HTTP.
- Errors users can see are `Vid2ContextError` with a stable `code` and a `hint` that says how to recover.
- `packages/core` stays runtime-neutral: no `node:*` imports.
- New env vars go into `.env.example` and `docs/providers.md` in the same commit.
- Keep raw transcripts. Summaries, briefs and translations are added layers, never replacements.
- Free first: local, then free tiers with the user's key, then keyless, then paid. Every model id is overridable from env.

## Tests

- Unit tests replay real responses recorded from the real service (`replayFetch` and `testContext` from `@vid2context/core/testing`). Never invent payloads.
- Live tests are gated: `describe.skipIf(!process.env.LIVE)`.
- Before committing a fixture, remove anything personal (stream URLs embed your IP; emails, phone numbers, keys) and document the file in its `test/fixtures/README.md`.
- Shared real fixtures: `tests/fixtures/media/apollo11-small-step.mp3` (public domain) and `tests/fixtures/contexts/*.json` (real `VideoContext` output).
- When a credential is missing, use a keyless or local rung or recorded fixtures, and report what could not be verified live.

## Working in parallel

Many agents work in this folder at the same time. These rules keep them from breaking each other's work.

- Own one directory. Touch only files there, plus its tests and docs. If a shared file must change, keep the edit minimal and additive.
- Only item 46 edits `packages/server` and only item 44 edits `packages/mcp`. Other packages export route and tool factories from their own `src/http.ts` and `src/mcp.ts` (see `docs/contracts/`).
- Stage explicit paths only. Never run `git add -A`, `git add .` or `git commit -a`.
- Re-check `git status` and `git diff --staged` right before committing, and commit your own finished work promptly. Never commit or stage another agent's files.
- Add dependencies only to your own package's `package.json`. `package-lock.json` is derived: if it conflicts, rerun `npm install`.
- Never hand-edit `packages/registry/src/generated/`; `npm run gen` rebuilds it.
- Re-read a file before editing it if your task has run for a while; another agent may have changed it.

## Git

- Commit messages: `type(scope): what changed and why it matters`, for example `feat(youtube): fall back to srv1 when srv3 is empty so old tracks still parse`. Never "update" or "wip".
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commit and push only when the owner asks. Never force-push.
- Commit and push only as user `nirholas` with the owner's GitHub noreply email: `22895867+nirholas@users.noreply.github.com` or the older `nirholas@users.noreply.github.com` (same account). Before every commit, check `git config user.name` and `git config user.email`; if either is anything else, stop and tell the owner instead of committing. Never pass `--author`, set `GIT_AUTHOR_*` or `GIT_COMMITTER_*`, or change git config to another identity.
- Never publish an email address or other personal detail anywhere: not in commits, code, docs, fixtures, issues, PRs, logs or requests to outside services. The only addresses allowed in a commit are the noreply identity above and the `Co-Authored-By` trailer.
- GitHub Actions is unavailable on this account (billing locked since 2026-09-15), so workflows there fail. Verify with `npm run check` locally, or use Cloud Build.
- Use the `gh` CLI for GitHub. Never put tokens in remote URLs.

## Owner

nirholas (GitHub: nirholas). On big design choices, talk through the approach first; once a direction is agreed, execute without further questions.
