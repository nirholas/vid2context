# Deploy to GitHub Pages (client-only)

GitHub Pages serves static files only, so this build has no server: the site, the web app and the chat app run entirely in the browser (`VITE_CLIENT_ONLY=1`). In client-only mode the apps use in-browser speech-to-text and LLMs on local files, or the user's own provider keys (stored in the browser's IndexedDB, never sent anywhere but the provider). Optionally the apps can point at a vid2context API you run elsewhere.

GitHub Actions is unavailable on this account, so publishing is a local script that commits to the `gh-pages` branch from a temporary git worktree.

## Publish

```sh
npm run deploy:pages -- --dry-run                       # build and commit in a throwaway clone; touches nothing
npm run deploy:pages                                    # build and commit to the local gh-pages branch, no push
npm run deploy:pages -- --push                          # ... and push gh-pages to origin
npm run deploy:pages -- --cname pages.vid2context.com --push   # custom domain
npm run deploy:pages -- --api-base https://vid2context.com/api/v1 --push   # apps call a real API
```

Then, once, in the repository settings: Pages, Build and deployment, Source "Deploy from a branch", branch `gh-pages`, folder `/ (root)`.

| Option | Default | Meaning |
|---|---|---|
| `--api-base <url>` | empty | `VITE_API_BASE` for the apps; empty means pure client-only |
| `--cname <domain>` | none | writes `CNAME` and serves from the domain root |
| `--base-path <path>` | `/` with `--cname`, else `/vid2context/` | URL prefix of the whole tree |
| `--branch`, `--remote` | `gh-pages`, `origin` | where to commit and push |
| `--dry-run` | off | do everything in a temporary clone of the repo; never pushes |
| `--push` | off | push after committing; nothing is pushed without it |
| `--no-build` | off | reuse existing app `dist/` folders |
| `--strict` | off | fail when an app is present but does not build |

## Paths

Without a custom domain the site lives at `https://nirholas.github.io/vid2context/`. The script builds the apps with Vite `--base /vid2context/app/` (and `/chat/`) and rewrites the site's root-absolute links (`href="/llms.txt"`) to the prefix. With `--cname` everything is served from `/`.

GitHub Pages has no rewrites, so app deep links rely on the apps' query-string URLs (`/app/?url=...`, `/chat/?input=...`, as the web contract defines); path-style deep links would hit the site's 404 page.

## What the script does

1. Builds `dist/pages/` with `deploy/serverless/lib/assets.mjs` (client-only, base path applied), adds `.nojekyll` (so `_`-prefixed files are served) and `CNAME` when asked.
2. Checks the git identity is `nirholas` with a noreply address, as AGENTS.md requires.
3. Adds a temporary worktree for `gh-pages` (creating an orphan branch the first time, or tracking `origin/gh-pages` if it exists), replaces its contents with the build, and commits only if something changed.
4. Pushes only with `--push`, then removes the worktree. Git commands in the real repo run under the shared lock `.vid2context/locks/git`.

## Limits

GitHub Pages sites are public, limited to 1 GB, and have a soft bandwidth limit of 100 GB per month. The live API demo on the landing page needs a server, so it does not work on a pure client-only Pages build.
