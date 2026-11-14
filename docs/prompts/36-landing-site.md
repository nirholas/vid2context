# 36. The landing site

| | |
|---|---|
| Track | H. Surfaces |
| You own | `site/` |
| Shared edits allowed | root `package.json` (the `build:site` script and site-related scripts only); root `wrangler.jsonc` (only `assets.directory`, if the build output moves) |
| Commit scope | `site` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. vid2context.com is the first thing people see. The owner wants a landing page in the style of the top trending open-source projects (LobeHub's site is the reference: a big confident hero, product shots, grids of providers, dark theme) that explains how the project works, with a hero input that behaves like the owner's earlier site llm.energy: paste a link, press the button, and you land in the app with your result on the way. Today `site/` holds a hand-written static page (`site/index.html`, `site/404.html`, committed in 09fe38a) that the root `wrangler.jsonc` serves as Worker assets next to the HTTP API. This prompt rebuilds it as a real site: Astro with React islands, the shared design tokens, docs pages, SEO and agent-discovery files, every number computed from the repo.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` and `README.md` (for copy, not to edit).
2. The current `site/index.html` and `site/404.html`: keep what is good (copy, the "Try it" live demo calling `/api/v1/transcript`, the "How it works" chain explanation, the tier table) and restyle it.
3. Root `wrangler.jsonc` (assets directory `site`, `run_worker_first`, `404-page` handling), root `package.json` scripts (`build:site`, `dev:worker`, `deploy`), `packages/server/src/workers.ts` (how the Worker serves assets and the API).
4. `docs/providers.md` and the generated registry (`packages/registry/src/node.ts`, `npm run gen`): the provider grid is built from them at build time.
5. `docs/prompts/SHARED-CONTRACTS.md`, section 6 (stack, URL layout, hand-off links, design tokens, visual language) and section 8.

## Goal

`npm run build:site` produces a static, fast, accessible site that the existing Worker serves at `/`, with a hero input that sends links to `/app/?url=`, sections that explain the product clearly, docs pages under `/docs/` rendered from the repo's Markdown, and the SEO and agent-discovery files. `npm run dev:worker` and `npm run deploy` keep working.

## Requirements

### Project setup

- Astro project inside `site/` (`site/astro.config.mjs`, `site/src/`, `site/public/`, its own `package.json` as an npm workspace is not required: if you make `site/` a workspace, add it without changing the root `workspaces` globs, which only cover `packages/*` and `providers/*`; simplest is a self-contained `site/package.json` installed through the npm lock with `--prefix site`). React islands only where interaction is needed (hero input, copy buttons, theme toggle, live demo).
- Tailwind CSS v4 with `site/src/styles/tokens.css` copied unchanged from SHARED-CONTRACTS section 6. Self-hosted fonts through `@fontsource` (Inter, JetBrains Mono). Dark is the default; light theme via `data-theme` and the `v2c.theme` localStorage key.
- Static output into `site/dist/` (gitignored by the existing `dist/` rule). Point `wrangler.jsonc` `assets.directory` to `site/dist` and update `build:site` to build Astro and copy `llms.txt` and `llms-full.txt` into the output. Remove the hand-written files only once the Astro build replaces them. Keep `404.html` in the output for `not_found_handling`.
- Prompt 50 (serverless) assembles `/app/` and `/chat/` builds into the same assets directory at deploy time. Do not create `app/` or `chat/` folders yourself; leave room for them and do not let your routes collide with those paths.

### Sections, in order

1. Sticky nav: logo, How it works, Docs, GitHub (with the real star count fetched at build time through `https://api.github.com/repos/nirholas/vid2context`, falling back to no number if the request fails), and an "Open app" button to `/app/`.
2. Hero: headline (for example "Turn any video into context for AI agents"), one-line sub ("Paste a link or drop a file. Get the transcript, chapters and metadata as Markdown, a .zip, or straight into your agent over MCP."), one large rounded input with the gradient primary button, modeled on llm.energy's extract box. Submitting goes to `/app/?url=<encoded>`. "Try:" chips with real public videos (the G-Wagon buyer's guide `https://www.youtube.com/watch?v=cCPsdFdlshc`, "Me at the zoo" `jNQXAC9IVRw`, a podcast episode, a Vimeo video). Small badges: "Free and open source", "No key needed", "Runs locally".
3. Demo panel: a real result rendered at build time from `tests/fixtures/contexts/youtube-jNQXAC9IVRw.json` with the core formatters (`render` from `@vid2context/core`), shown like llm.energy's result page (file list on the left: context.md, transcript.srt, metadata.json; viewer on the right). Keep the current live "Try it" demo as an island that calls `/api/v1/transcript` and shows the result and the attempts, with the existing note about YouTube blocking cloud IPs.
4. How it works, three steps: paste or upload; captions first, else free-first speech-to-text (show the chain: creator captions, auto-captions, speech-to-text, video model); copy, download a .zip, or connect your agent.
5. Sources grid: YouTube, Vimeo, TikTok, X, Instagram, Twitch, podcasts, local files, "1000+ sites via yt-dlp". Only claim sources for which a provider package exists at build time, or label the rest "with the yt-dlp provider".
6. "Bring any model": rungs grouped by tier (local, free, keyless, paid), generated at build time from the real registry (`createRegistry()` and each provider's `rungs({})` metadata) and `docs/providers.md`, with tier colors from the tokens. Never hand-maintain this list.
7. Agents and MCP: copy-button snippets for Claude Code (`claude mcp add vid2context -- npx tsx packages/mcp/src/bin.ts` for now), Claude Desktop, ChatGPT (context pack upload today, remote connector later), Cursor, VS Code. Keep commands in one data file so prompt 16 (integrations) can correct them later.
8. Use cases: researching a buying decision across a playlist (the G-Wagon story: which model, year and mileage, with every claim cited to an episode and timestamp), learning from tutorials, podcast notes.
9. Self-host and deploy: Docker, Cloudflare, Vercel, Railway, with links to `docs/deploy/` pages when they exist.
10. FAQ (cost, privacy, which sites, YouTube blocking, keys), and a footer (GitHub, docs, license Apache-2.0, llms.txt).

### Docs pages

- `/docs/` rendered at build time from the repo's Markdown: `README.md`, `docs/ARCHITECTURE.md`, `docs/providers.md`, `docs/contracts/*.md`, and every `docs/guides/*.md` and `docs/deploy/*.md` that exists at build time. Sidebar, in-page table of contents, code highlighting, relative links rewritten to site URLs. Do not copy the Markdown into `site/`: read it from the repo at build time so it never drifts.

### SEO and agent discovery

- Per-page title and description, canonical URLs on `https://vid2context.com`, Open Graph and Twitter cards with an OG image generated at build time (no external service), `sitemap.xml`, `robots.txt`, JSON-LD `SoftwareApplication`.
- `/llms.txt` and `/llms-full.txt` from the repo files, linked with `<link rel="alternate">`.

### Copy and quality rules

- No em-dashes or en-dashes, no emojis, no invented numbers, testimonials, user counts or company logos. Every number on the page (providers, rungs, sources, stars) is computed at build time.
- Lighthouse 95 or more in every category on desktop and mobile; run it against the built site and put the scores in your report. No third-party requests at runtime (no analytics, no Google Fonts, no CDN scripts).
- WCAG 2.2 AA: contrast, focus rings, keyboard navigation, landmarks, reduced-motion support for any animation.
- Responsive down to 360 px.

## Out of scope

- The app at `/app/` (prompt 47) and the chat at `/chat/` (prompt 28).
- Worker code and bindings: prompt 46 owns `packages/server/src/workers.ts`, prompt 50 owns the rest of `wrangler.jsonc` and deploy scripts.
- Integration installers: prompt 16.

## Tests

- The build succeeds from a clean checkout (`npm run build:site`).
- A link checker over `site/dist` (internal links and anchors resolve; external links listed, not fetched in unit runs).
- A build-time test that the provider grid matches the registry (count of rungs per tier equals the registry's).
- Playwright smoke test when Playwright is available: the hero input navigates to `/app/?url=<encoded>`, the theme toggle persists, the 404 page renders. If Playwright is not installed, say so and check manually with `wrangler dev`.

## Acceptance criteria

- [ ] `npm run build:site` writes the site to the directory `wrangler.jsonc` serves, including `llms.txt`, `sitemap.xml`, `robots.txt` and `404.html`.
- [ ] `npm run dev:worker` serves the new site at `/` and the API at `/api/v1/health` (check with curl on a random port).
- [ ] Hero submit goes to `/app/?url=...` with the input encoded.
- [ ] Lighthouse scores recorded in your report, all 95 or higher.
- [ ] `grep -rP '[\x{2013}\x{2014}]' site/src` prints nothing.
- [ ] `npx biome check site` is clean for the files Biome understands (note any `.astro` limits in your report).

## Docs

- `site/README.md`: how to develop, build, add a docs page, and where the generated data comes from.

## If credentials, tools or network are missing

No keys are needed. If the GitHub API is unreachable at build time, render without a star count. If Lighthouse or Playwright cannot run here, report it and describe the manual checks you did instead.

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
