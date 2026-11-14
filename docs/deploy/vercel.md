# Deploy to Vercel

The same layout as Cloudflare (site at `/`, `/app/`, `/chat/`, the API at `/api/v1/*`), deployed as a prebuilt Vercel Build Output API v3 tree. Nothing builds on Vercel's side and no `vercel.json` is needed.

## Build and deploy

```sh
npm run build:vercel                  # writes .vercel/output/ (gitignored)
npx vercel deploy --prebuilt          # preview deployment
npx vercel deploy --prebuilt --prod   # production
```

The first `vercel deploy` asks you to log in and to link or create a project; accept the defaults. Add provider keys in the project's Settings, Environment Variables (the same names as `.env.example`), or with `npx vercel env add GROQ_API_KEY`.

## What gets built

| Path in `.vercel/output/` | Content |
|---|---|
| `static/` | the assets tree from `deploy/serverless/lib/assets.mjs` (same as Cloudflare) |
| `functions/api.func/index.mjs` | the HTTP API bundled into one ESM file with esbuild, Node.js 22 runtime |
| `functions/api.func/.vc-config.json` | runtime settings (`nodejs22.x`, streaming responses on) |
| `config.json` | routes, in order: `/api/*`, `/mcp` and `/.well-known/oauth-*` to the function; files; app fallbacks (`/app/*` and `/chat/*` serve their `index.html` for paths that do not look like files); then `404.html` |

The function is `deploy/serverless/vercel/function.ts`: `createApp` from `packages/server` wrapped with `getRequestListener` from `@hono/node-server`. It reads env from `process.env` and uses Vercel's `x-real-ip` header (which Vercel sets and clients cannot spoof) for per-IP rate limits.

The build uses `esbuild`, which is already installed with `tsx` and `vitest`. It should become a declared root devDependency (prompt 38 owns those).

## What runs on Vercel

The function uses the fetch-only provider set (the same one the Cloudflare Worker runs), deliberately not the Node registry:

| Works | Does not |
|---|---|
| YouTube metadata and captions | yt-dlp, ffmpeg, whisper.cpp and local models (no binaries, short-lived functions) |
| Hosted and keyless speech-to-text for small uploads (request bodies are capped at 4.5 MB on Vercel) | Reading local files: a public function must never read the server's filesystem, so `?url=/etc/passwd` is refused with 400 |
| Every hosted and keyless LLM rung | Long jobs: Hobby functions stop after 60 seconds by default |

Use the Docker deploy (`deploy/containers/`, prompt 49) when you need yt-dlp, ffmpeg or local models on a server.

## Verified locally

`deploy/serverless/test/targets.test.ts` builds the output, loads the bundled function into a real Node HTTP server, checks `/api/v1/health` and the local-path refusal, and checks the route order. On 2026-11-14 the route table also passed Vercel's own validator (`normalizeRoutes` from `@vercel/routing-utils` 6.6.1). The Vercel CLI was not installed on the build machine, so `vercel build` and a real deployment have not been run.
