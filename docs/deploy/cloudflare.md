# Deploy to Cloudflare (Workers + static assets)

One Worker serves all of vid2context.com:

| Path | What |
|---|---|
| `/` and `/docs/*` | the landing site (`site/`) |
| `/app/` | the web app (`packages/web`), when it builds |
| `/chat/` | the chat app (`packages/chat`), when it builds |
| `/api/v1/*` | the HTTP API (`packages/server`) |
| `/mcp` | remote MCP, once `packages/server/src/workers.ts` routes it (prompt 46) |
| `/llms.txt`, `/llms-full.txt` | the repo's LLM-readable docs |

The config is the root `wrangler.jsonc`; the Worker entry is `packages/server/src/workers.ts`; static files come from `dist/assets/`, built by `npm run build:assets`.

## Commands

```sh
npm run build:assets            # assemble dist/assets (site, apps that build, llms.txt)
npm run dev:worker              # build assets, then wrangler dev on http://localhost:8787
npm run deploy                  # build assets, then wrangler deploy (needs CLOUDFLARE_API_TOKEN)
npx wrangler deploy --dry-run --outdir dist/worker   # bundle and validate without uploading
```

`build:assets` skips an app that is missing or does not build, and says why. Add `-- --strict` to make that an error (do this for production once `packages/web` and `packages/chat` exist): `npm run build:assets -- --strict && npx wrangler deploy`.

A dry run on 2026-11-14 bundled the Worker to 120 KiB (33 KiB gzipped); the free plan allows 3 MiB compressed. No `nodejs_compat` flag is needed: the Workers registry contains only fetch-based providers.

## Credentials

`wrangler deploy` needs a Cloudflare API token with the "Edit Cloudflare Workers" template, in `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID` if the token can see several accounts). Put both in `.env` or your shell; never in `wrangler.jsonc`.

## Secrets and variables

Provider keys and API keys are Worker secrets, set once per key:

```sh
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put VID2CONTEXT_API_KEYS     # comma-separated keys for /api/v1 when the API should not be open
```

Every variable in `.env.example` works the same way. `wrangler.jsonc` sets one plain variable, `VID2CONTEXT_PUBLIC=1`, which marks this deployment as the public, internet-facing instance.

## Optional bindings

All are commented out in `wrangler.jsonc`. Without them the Worker keeps the library in memory (per isolate), uses hosted and keyless rungs, and runs no background jobs. To turn one on, create the resource, uncomment its block, and uncomment the matching variable in `vars` (the storage provider reads the variable to find the binding).

| Binding | Create with | Variable | Used by |
|---|---|---|---|
| D1 `DB` | `npx wrangler d1 create vid2context` | `VID2CONTEXT_D1=DB` | the library: contexts, collections, search (providers/storage-cloudflare) |
| R2 `MEDIA` | `npx wrangler r2 bucket create vid2context-media` | `VID2CONTEXT_R2=MEDIA` | large contexts and uploads |
| KV `KV` | `npx wrangler kv namespace create vid2context` | `VID2CONTEXT_KV=KV` | KvStore: sessions, API keys, webhooks, caches |
| Workers AI `AI` | nothing to create | none | free Whisper and LLM rungs through the binding (providers/cloudflare-ai) |
| Queue `JOBS_QUEUE` | `npx wrangler queues create vid2context-jobs` | none yet | background jobs (packages/jobs); needs a `queue` handler in the Worker entry |
| Cron trigger | nothing to create | none | watch-list refresh (prompt 41); needs a `scheduled` handler in the Worker entry |

Free limits that matter (Workers Free plan, as published by Cloudflare): 100,000 requests per day, 10 ms CPU per request (I/O wait such as calling YouTube or an LLM does not count), D1 5 GB, R2 10 GB, KV 100,000 reads per day, Workers AI 10,000 neurons per day. Long speech-to-text jobs belong on Node or in a queue consumer, not in a request.

## What runs on Workers

| Works | Does not |
|---|---|
| YouTube metadata and captions (innertube, plain fetch) | yt-dlp, ffmpeg, whisper.cpp and other binaries |
| Hosted and keyless speech-to-text for uploads within each rung's size limit | Local files (there is no filesystem; the media-file source is not in the Workers registry) |
| Every LLM rung that speaks HTTP, including keyless OVH and Pollinations | Local models (Ollama, LM Studio) unless exposed over HTTPS |
| Workers AI through the `AI` binding | Long-audio splitting (needs ffmpeg) |

YouTube blocks many datacenter IPs. Cloudflare's egress IPs are shared and sometimes rate-limited: when captions fail with `blocked`, the API says so with a hint. A Cloudflare Tunnel to a machine at home (see the remote MCP guide) avoids that.

## Domain

- `vid2context.com` and `www.vid2context.com` are custom domains in `routes`; Cloudflare creates the DNS records and certificates on the first deploy. The Worker redirects `www.` to the bare domain.
- The zone must be active first: at the registrar, set the domain's nameservers to the two Cloudflare assigns (dashboard, the zone's Overview). Until Cloudflare sees them the zone stays "pending" and no certificate is issued, so browsers show `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`. The certificate usually follows within 15 minutes of activation.
- `vidtocontext.com`: add it to the same Cloudflare account, then create a redirect rule (Rules, Redirect Rules, "Redirect from root to WWW" style, custom): when hostname equals `vidtocontext.com` or `www.vidtocontext.com`, redirect to `https://vid2context.com${path}` keeping the query string, status 301. The zone needs a proxied DNS record (for example an `A` record to `192.0.2.1`, proxied) so requests reach the rule.
- `vid2context.<account>.workers.dev` stays on as a fallback URL (`workers_dev: true`).

## Asset size limit

Workers static assets reject any file above 25 MiB, and `npm run build:assets` fails the build when one is present. The one known exception is handled: the web and chat apps bundle transformers.js, so Vite copies ONNX Runtime's WASM (the asyncify build is about 25.6 MiB) into their `assets/`. In the browser, transformers.js loads that WASM from `cdn.jsdelivr.net` unless the app sets `TRANSFORMERS_WASM_PATH`, so the copy is never fetched, and the build removes oversize `ort-wasm*.wasm` files with a log line. To self-host ONNX Runtime instead, serve its files from a host without the limit (R2, for example) and point `TRANSFORMERS_WASM_PATH` there.

## SPA routing for the apps

`/app/*` and `/chat/*` deep links must serve each app's `index.html`. Workers static assets cannot do this per path: `not_found_handling` is global, and `_redirects` rewrites apply even when a file exists, so `/app/* /app/index.html 200` would also rewrite the app's own JavaScript. The Worker does it instead with `fetchAssetWithSpaFallback` from `deploy/serverless/cloudflare/spa-fallback.ts`: assets first, and only on a 404 for a non-file path under an app mount, that app's index. It is verified in the Workers runtime by `deploy/serverless/test/worker.test.ts` (`WRANGLER_TEST=1`). Wiring it into `packages/server/src/workers.ts` is one line, listed for prompt 46.

## Verify a deploy

```sh
curl https://vid2context.com/api/v1/health
curl "https://vid2context.com/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw&timestamps=1"
npx wrangler tail          # live logs
```
