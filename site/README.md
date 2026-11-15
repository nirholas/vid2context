# vid2context.com

The landing page and docs: Astro with React islands, built to static files in `site/dist/`. The root `npm run build:assets` copies them into `dist/assets/`, which `wrangler.jsonc` serves next to the HTTP API, `/app/` and `/chat/`.

## Develop

From the repo root, after `npm install`:

```sh
npm run build:site   # data + Astro build into site/dist (installs site/ dependencies on first run)
npm run dev:site     # generate data, then astro dev with reload on http://localhost:4321
npm run test:site    # build checks (vitest) and browser smoke tests (Playwright)
npm --prefix site run lighthouse   # Lighthouse, desktop and mobile, fails below 95
```

`site/` is its own npm project, not a workspace. Install or add a dependency with `flock .vid2context/locks/npm npm install --prefix site <name>@<version>`. It imports the workspace packages (`@vid2context/core`, `registry`, `discovery`, `mcp`) from the root `node_modules`, so run `npm install` at the root first.

Playwright and Lighthouse use `CHROME_PATH` when set, else the Chromium this Playwright version installs, else any Chromium already in the Playwright cache (`scripts/chromium.mjs`).

## Where the numbers come from

Nothing on the site is typed in by hand when the repo knows it. `scripts/gen-data.ts` runs before every build and writes `src/generated/site-data.json` (gitignored):

| Data | Source |
|---|---|
| Rungs per tier, services, the model grid | the provider registry (`createRegistry()` and each provider's `rungs({})`), with notes from `docs/providers.md` |
| Sources | sample links per platform resolved through the registry, offline: a platform is claimed only when a provider understands it |
| yt-dlp site count | `yt-dlp --list-extractors` from the binary the ytdlp provider installs, left out when it is missing |
| MCP tools | the MCP server started in memory, `tools/list` |
| Install commands and one-click links | `@vid2context/discovery` (`claudeCodeCommand`, `mcpServersJson`, `vscodeInstallUrl`, `cursorInstallUrl`, `lmStudioDeeplink`, `gooseDeeplink`, ...) |
| npx or a clone | the npm registry: a real release of `vid2context-mcp` and `vid2context` that ships its bin. Until then the steps run from a clone |
| Demo bundle, transcripts, context pack | `buildBundle` and `render` from `@vid2context/core` over `tests/fixtures/contexts/` |
| Whisper example | the recorded OVH response in `providers/stt-openai-compatible/test/fixtures/` |
| Playlist example | the YouTube source's `listItems`, replaying `providers/youtube/test/fixtures/browse/` |
| Deploy targets | listed only when the repo has them (`deploy/`, `wrangler.jsonc`, `docs/deploy/*.md`, root scripts) |
| Sitemap `lastmod` | the last git commit of each page's source files |
| GitHub stars | `api.github.com/repos/nirholas/vid2context`, left out when the request fails |

`SITE_OFFLINE=1` skips the two network calls (stars, npm). `SITE_STRICT=1` fails the build when a provider package does not import; without it, a broken package mid-change is skipped and logged.

## Pages

- `/`: `src/pages/index.astro`, sections in `src/components/landing/`, copy in `src/data/landing.ts`.
- `/docs/...`: `src/pages/docs/[...slug].astro`. Pages come from `src/lib/docs.ts`:
  - the repo's Markdown, read at build time and never copied: `README.md`, `docs/ARCHITECTURE.md`, `docs/providers.md`, `docs/contracts/*.md`, and every `docs/guides/*.md` and `docs/deploy/*.md`. Relative links become site URLs (or GitHub links for files that are not pages);
  - one page per agent client, generated from `src/data/agents.ts`;
  - the site's own pages in `src/content/tutorials/`, `src/content/examples/`, `src/content/how-to/` and `src/content/compare/` (an `index.md` is the section's landing page, `/docs/tutorials/`);
  - the runnable scripts' pages in `docs/examples/` (its `README.md` is `/docs/examples/scripts/`), listed under Examples after the site's own pages.
- Every page has a Markdown twin: `/` is `/index.md`, `/docs/x/` is `/docs/x.md`. Pages link it with `<link rel="alternate" type="text/markdown">`.
- `robots.txt`, `sitemap.xml`, `llms.txt` (the repo copy plus every docs twin under `## Docs`), `llms-full.txt`, `favicon.svg`, `apple-touch-icon.png` and one Open Graph image per page (`/og/...png`, satori and sharp) are endpoints in `src/pages/`.

## Add a docs page

- A repo guide: add `docs/guides/<name>.md` (or `docs/deploy/<name>.md`). It appears on the next build.
- A site page: add `src/content/how-to/<slug>.md` or `src/content/compare/<slug>.md` with frontmatter:

  ```markdown
  ---
  title: Give Claude a YouTube video
  label: Short sidebar label
  description: One sentence for search results and the OG image.
  order: 2
  requires: playlist
  ---
  ```

  `requires` (optional) names a key of the generated data; the page is left out when it is missing. Write `{{token}}` instead of retyping commands or outputs: `{{client:cursor}}` (install steps), `{{demo.mcpTranscript}}`, `{{demo.contextMd}}`, `{{whisper.text}}`, `{{install.claudeCode}}`, `{{cli}}`, `{{formats.list}}` and the rest in `src/lib/tokens.ts`. An unknown token fails the build.
- An agent client: add it to `src/data/agents.ts`.

## Runnable examples

Tutorials and examples pages hold runnable HTTP API requests. In a site page, a fenced block whose info string is `run <id>` (and no body) becomes one:

````markdown
```run transcript-timestamps
```
````

- `src/data/runnables.ts` is the catalog: one typed spec per request (method, path, fields and where each goes, the CLI and MCP equivalents, whether it answers a job, a stream or a zip). Videos are real and public; format lists come from the core formatter map.
- `src/lib/runnable.ts` is shared by the build and the browser: it builds the request, the curl, JavaScript (fetch), Python (standard library), CLI and MCP snippets, highlights them, and presents responses (JSON, text, server-sent events, zip listings).
- `src/lib/runnable-render.ts` renders a block at build time with the response recorded in `test/fixtures/runnables/<id>.json`, and gives the Markdown twin the curl command and that response instead.
- `src/scripts/runnables.ts`, loaded by `src/components/RunnableRuntime.astro` only on pages with blocks, makes them live: snippets follow edits, Run calls the API on this site, a local server or a custom URL (with an optional key kept in session storage), jobs are polled, streams render as they arrive, a `provides` value (an upload's `input`, a new collection's `id`) fills the later blocks that read it, and **Share** copies a link that carries the block's edited fields (`?rx.<block id>=<fields>`) so it opens filled in.
- `{{pages:<dir>}}` in a section's `index.md` lists the section's other pages.

Add an example: add a spec to `src/data/runnables.ts`, start a server (`npm run start:server` at the root), record it with `npm --prefix site run record -- <id>`, and put a `run <id>` block on a page. `test/runnables.test.ts` fails until every block has a spec, every spec a recording made with its current default request, and no recording holds an email, a stream URL with an IP or a key. `test/fixtures/README.md` describes the recordings.

To try blocks against a local server while developing, start it with `VID2CONTEXT_CORS_ORIGINS=http://localhost:4321 npm run start:server` and pick **Local server** on any block.

## Rules the tests enforce

`test/build.test.ts` runs over `dist/`: internal links and anchors resolve (external links are listed, not fetched; `/app/`, `/chat/`, `/api/` and `/mcp` belong to other builds), every page has a canonical URL on `https://vid2context.com`, Open Graph tags, a 1200x630 image and a twin, one JSON-LD `@graph` per page, the model grid equals the registry per tier, robots.txt names the AI crawlers, sitemap dates come from git, no third-party requests, the landing page ships under 100 KB of gzipped JavaScript, and `site/src` has no en or em dashes. `e2e/runnables.spec.ts` runs blocks against a real API server that `playwright.config.ts` starts next to the preview (memory storage, CORS open to the preview origin): live responses, snippets that follow edits, keyboard tabs, input errors, an unreachable server, the settings dialog, and no runtime script on pages without blocks. `e2e/smoke.spec.ts` checks the hero hand-off to `/app/?url=`, the theme toggle, the 404 page, the demo viewer and docs copy buttons.

Biome reads `site/biome.json`, which extends the root config. Biome only parses the frontmatter of `.astro` files, so imports and variables used in the template look unused there; those two rules are off for `.astro` only.

Design tokens in `src/styles/tokens.css` are copied unchanged from `docs/prompts/SHARED-CONTRACTS.md` section 6; update them there first.
