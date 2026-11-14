# Discovery: how agents and search engines find vid2context

Roadmap item 51, owned by `packages/discovery`. Formats were checked against each vendor's docs on 2026-11-14; re-check before relying on one that is marked experimental.

## What is in the repo

| File | Who reads it | Source |
|---|---|---|
| npm `vid2context-mcp`, `vid2context` | npx, every MCP client, every directory that installs from npm | `npm run build:npm` bundles `packages/mcp` and `packages/cli` into `packages/discovery/dist/npm/` |
| `server.json` | Official MCP Registry, and the clients and directories that mirror it (VS Code, GitHub, Glama, mcp.so) | generated |
| `glama.json` | Glama (claims the listing for `nirholas`) | generated |
| `Dockerfile`, `.dockerignore` | Glama's build check (listings only appear after a reproducible build), Docker MCP Catalog | hand-written, builds the bundle from source |
| `gemini-extension.json` | Gemini CLI (`gemini extensions install <repo>`) and its gallery | generated |
| `context7.json` | Context7, which coding agents query for library docs | generated |
| `llms-install.md` | Cline marketplace and any agent asked to install the server | generated |
| `llms.txt`, `llms-full.txt` | IDE agents and MCP doc tools (crawlers rarely fetch it, agents do) | hand-written |
| `AGENTS.md` | coding agents working in the repo | hand-written |
| `packages/discovery/assets/logo.{svg,png}` | registry icon, Cline's 400x400 logo, favicons | `npm run discovery:logo` renders the PNG |
| README install section, badges and FAQ | GitHub search, Google, answer engines | hand-written; a test keeps its commands and links equal to `src/install.ts` |

Generated files come from `packages/discovery/src/meta.ts` (names, descriptions, keywords, optional keys) through `src/manifests.ts`. Change the facts there and run `npm run discovery:gen`; `npm test` fails if a committed copy drifts.

## Releasing

Run in order. Steps 2 and 3 need the owner's logins.

1. `npm run check && npm run build:npm`. Bump versions in `packages/mcp/package.json` and `packages/cli/package.json` first when releasing a new version, then `npm run discovery:gen` so `server.json` and `gemini-extension.json` follow.
2. `npm login` once, then `npm publish --access public packages/discovery/dist/npm/vid2context-mcp` and the same for `packages/discovery/dist/npm/vid2context`. Turn on 2FA for publishing. Check: `npx -y vid2context-mcp` starts and waits on stdin; `npx vid2context --version` prints the version.
3. MCP Registry: install `mcp-publisher` (`brew install mcp-publisher`, or the release tarball from github.com/modelcontextprotocol/registry), then `mcp-publisher validate`, `mcp-publisher login github` (device flow, grants `io.github.nirholas/*`) and `mcp-publisher publish` from the repo root. The registry checks that npm `vid2context-mcp` carries `"mcpName": "io.github.nirholas/vid2context"`, which the build sets.
4. Commit the README, llms files and manifests together with or after the publish, never before: they tell agents to run `npx -y vid2context-mcp`.
5. Tag and release on GitHub (`gh release create v0.1.0 --generate-notes`). Releases matter for GitHub search ranking, the Gemini extension gallery and directory freshness checks.

## Directory submissions (owner, once, after step 3)

| Where | How | Notes |
|---|---|---|
| Glama | glama.ai/mcp/servers, "Add MCP Server", sign in with GitHub, paste the repo | `glama.json` proves ownership; the `Dockerfile` makes the build check pass. Its score badge then goes in the README |
| Cline marketplace | github.com/cline/mcp-marketplace, issue template "MCP server submission": repo URL, `packages/discovery/assets/logo.png`, reason | confirm Cline installed it from `llms-install.md` first |
| Docker MCP Catalog | fork docker/mcp-registry, `task create -- --category media https://github.com/nirholas/vid2context`, open the PR | it builds the root `Dockerfile` and checks that tools list |
| Context7 | context7.com/add-library, paste the repo | reads `context7.json` |
| Gemini CLI gallery | add the repo topic `gemini-cli-extension` and publish a release | crawled daily |
| Claude Code | after prompt 16 adds `.claude-plugin/marketplace.json`: `claude plugin marketplace add nirholas/vid2context` works for everyone; the Anthropic directory takes submissions at claude.ai/directory/manage | |
| Cursor directory | cursor.directory/plugins/new, paste the repo | |
| awesome-mcp-servers | PR one line to punkpeye/awesome-mcp-servers under "Multimedia Process", alphabetical: `- [nirholas/vid2context](https://github.com/nirholas/vid2context) 📇 🏠 ☁️ - Video to context for agents: YouTube and media-file transcripts with timestamps, metadata and chapters; captions first, free-first speech-to-text fallback.` | that list's own format uses those emoji; keep them only there |
| mcp.so, MCP Market, mcp.directory, LobeHub | mcp.so/submit, mcpmarket.com/submit, mcp.directory/submit, lobehub.com/submit | paste the repo; most also read the MCP Registry |
| Other awesome lists | awesome-whisper, awesome-youtube, awesome-ai-agents, awesome-claude-code, awesome-llm-apps | one line each, only where the list's scope fits |

Not available: Smithery no longer accepts self-published servers (its CLI and API stopped on 2026-10-31; the site is a curated list run by Arcade). PulseMCP is closed to new submissions and points to the official registry. ChatGPT's app directory needs the remote HTTPS server from prompt 45.

## Search engines (owner)

- Done on 2026-11-14: Always Use HTTPS on, minimum TLS 1.2, `www` 301 to the apex (zone Single Redirect rule "www to apex"). Cloudflare AI-bot blocking and the managed robots.txt were already off; keep them off.
- Google Search Console: add the `vid2context.com` domain property (DNS TXT verification on Cloudflare) and submit `https://vid2context.com/sitemap.xml` once prompt 36 ships it.
- Bing Webmaster Tools: import from Search Console. Bing's index feeds ChatGPT search and Copilot, so this matters for answer engines, not just Bing.
- IndexNow: with Bing verified, ping IndexNow on deploy, or enable Cloudflare Crawler Hints in the dashboard (Caching, Configuration) so changed pages are reported automatically.
- GitHub repo settings: set the homepage to `https://vid2context.com` (currently without the scheme) and upload a social preview image (Settings, General, 1280x640) so links shared anywhere get a card. Keep the description and topics; add `gemini-cli-extension`.
- Launch posts that earn real links: Show HN, r/LocalLLaMA and r/ClaudeAI (lead with the zero-key, local-first angle), dev.to or a blog post with a real worked example (a playlist turned into cited notes). One post per venue, written for that venue.

## Handed to other prompts

- 36 (site): robots.txt naming the AI crawlers, sitemap with git dates, JSON-LD graph, Markdown twins, search-intent and per-client pages, install buttons from `src/install.ts`, favicons from the logo, performance budget.
- 46 (server): `Accept: text/markdown` negotiation, `Link` headers, `X-Robots-Tag: noindex` on `/api/*`.
- 16 (integrations): root `.claude-plugin/marketplace.json`, installers that write the published npx command.
- 45 (remote MCP): Server Card and `/.well-known/ai-catalog.json`, the `remotes` entry in `server.json`, ChatGPT app directory steps.
- 49 (containers): the full server image stays in `deploy/containers/`; the root `Dockerfile` is only the stdio MCP image the directories need.
