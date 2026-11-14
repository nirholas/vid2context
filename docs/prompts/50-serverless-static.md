# 50. Serverless and static deploys (Cloudflare, Vercel, GitHub Pages)

| | |
|---|---|
| Track | I. Deploy and quality |
| You own | `deploy/serverless/`, the root `wrangler.jsonc` (exists) |
| Shared edits allowed | root `package.json` (`scripts` entries only: keep `build:site`, `dev:worker` and `deploy` working, add `build:assets`, `deploy:pages`); `.gitignore` is not yours: put generated output under an already ignored path (`dist/` or `.vid2context/`) |
| Commit scope | `deploy` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The owner's domain vid2context.com runs on Cloudflare, and a first Worker already exists: `wrangler.jsonc` at the repo root points at `packages/server/src/workers.ts`, serving `/api/*` from the Hono app and everything else from `site/`. This prompt grows that into the full deployment: the landing site at `/`, the web app at `/app/`, the chat page at `/chat/` and the API on one Worker with optional D1, R2, KV, AI and cron bindings; a Vercel deployment of the same layout; and a GitHub Pages client-only build (GitHub Actions is unavailable on this account, so publishing is a local script).

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands, the GitHub Actions note), then `docs/ARCHITECTURE.md` (runtimes and deployment).
2. The root `wrangler.jsonc`, `packages/server/src/workers.ts`, `packages/server/src/app.ts`, `packages/registry/src/workers.ts` (`createWorkersContext` keeps only string bindings today; prompt 20 adds `ctx.bindings`), and the root `package.json` scripts.
3. `site/` (the current landing page) and `.gitignore` (`site/llms.txt` and `site/llms-full.txt` are generated).
4. `docs/contracts/http-api.md` (routes, auth, CORS) and `docs/providers.md` (which rungs work without Node: no yt-dlp, no ffmpeg, no whisper.cpp on Workers or Vercel edge).
5. `docs/prompts/SHARED-CONTRACTS.md` sections 6 (URL layout, `VITE_API_BASE`, client-only mode) and 8.

## Goal

`npm run deploy` publishes one Worker that serves `/` (site), `/app/` (web), `/chat/` (chat), `/api/v1/*` and `/mcp`, with documented optional bindings; `deploy/serverless/vercel/` deploys the same layout to Vercel; and `npm run deploy:pages` builds a client-only static bundle and publishes it to the `gh-pages` branch from a temporary worktree. Every build is verified locally.

## Requirements

### Cloudflare Worker (`wrangler.jsonc`, `deploy/serverless/cloudflare/`)

- Keep `packages/server/src/workers.ts` as the entry. It belongs to prompt 46: do not edit it. If the layout needs a change there (for example routing `/mcp` or passing bindings), describe the exact change in your report.
- Assets: a build script (`deploy/serverless/build-assets.mjs`, run by a new root script `build:assets`) that assembles one directory under an ignored path (for example `dist/assets/`): `site/` (or the Astro output prompt 36 produces, detected at build time), `packages/web/dist` at `/app/` and `packages/chat/dist` at `/chat/` when those packages exist and build, plus `llms.txt` and `llms-full.txt`. Point `assets.directory` at it. Missing packages are skipped with a clear message, never faked. Keep `npm run build:site`, `npm run dev:worker` and `npm run deploy` working (update them to call `build:assets`).
- SPA fallbacks: `/app/*` and `/chat/*` serve their `index.html` for client routes; keep the site's 404 page.
- Optional bindings as commented, documented blocks: D1 (`VID2CONTEXT_D1`), R2 (`VID2CONTEXT_R2`), KV (`VID2CONTEXT_KV`), Workers AI (`AI`), a Queue (for prompt 42), and a cron trigger (for watch lists, prompt 41). Use the binding names prompts 20, 41 and 42 document if they have landed; otherwise use these names and list them in your report.
- `nodejs_compat` only if a mounted package truly needs it; check the bundle with `wrangler deploy --dry-run --outdir`.
- Secrets: document `wrangler secret put` for provider keys and `VID2CONTEXT_API_KEYS`; never put values in the config. Set `VID2CONTEXT_PUBLIC=1` as a var.
- Domain: document vid2context.com as the custom domain (already in `routes`), `www` redirect (already in the Worker), and a redirect rule for vidtocontext.com to vid2context.com in the Cloudflare dashboard.

### Vercel (`deploy/serverless/vercel/`)

- A function entry using Hono's Vercel adapter around `createApp` with a context built from `process.env` on the Node runtime; `vercel.json` with rewrites matching the same layout (`/app/*`, `/chat/*`, `/api/*`, static site at `/`), built from the same assets script.
- Document what does not run there (yt-dlp, ffmpeg, local models) and what does (YouTube captions via innertube, hosted and keyless speech-to-text for small uploads, all LLM rungs).

### GitHub Pages client-only (`deploy/serverless/github-pages/`)

- A script `deploy/serverless/github-pages/publish.mjs` (root script `deploy:pages`) that builds the site, web app and chat with `VITE_CLIENT_ONLY=1` and a configurable `VITE_API_BASE` (empty means pure client-only), writes `.nojekyll` and a `CNAME` only when asked, creates a temporary `git worktree` on the `gh-pages` branch, copies the output, commits there, and pushes only with an explicit `--push` flag.
- During the wave, run everything up to and including the worktree commit in a throwaway clone or with `--dry-run`, never push, and never touch the main working tree's branches.

## Out of scope

- The Worker entry and server code: prompt 46. Storage bindings' implementation: prompt 20 (Cloudflare). Site, web and chat sources: prompts 36, 47 and 28.
- Containers: prompt 49. Cloud Build CI: prompt 38.

## Tests

- `npm run build:assets` produces the expected tree (assert paths in a small Node test under `deploy/serverless/test/`, run with Vitest by path).
- `npx wrangler dev` on a random port: `curl /api/v1/health`, `/`, `/app/` (when built), and `LIVE=1` a real `/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw` through the Worker.
- `npx wrangler deploy --dry-run --outdir <tmp>` succeeds; report the bundle size.
- Vercel: build output validated with `vercel build` if the CLI is installed; otherwise validate `vercel.json` against its schema and report.
- GitHub Pages: the publish script in `--dry-run` mode produces the tree and the worktree commit in a temporary clone.

## Acceptance criteria

- [ ] `npm run build:assets` and `npm run dev:worker` work from a clean checkout.
- [ ] `wrangler deploy --dry-run` succeeds and the config validates against the wrangler schema.
- [ ] The Vercel and GitHub Pages builds produce the documented layout.
- [ ] No secret values in any committed file.

## Docs

- `docs/deploy/cloudflare.md` (bindings, secrets, domain and redirect, free limits, what runs on Workers), `docs/deploy/vercel.md`, `docs/deploy/github-pages.md` (client-only mode, API base, publishing without Actions).

## If credentials, tools or network are missing

Do not deploy to the owner's accounts: `npm run deploy` needs `CLOUDFLARE_API_TOKEN`, which is the owner's call. Verify with `wrangler dev` and `--dry-run`. If the Vercel CLI is unavailable, say so. Report every step that was not run live.

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
