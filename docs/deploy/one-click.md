# One-click deploys

The buttons in the README's "Deploy your own" section create your own copy of vid2context on a hosting provider. This page says what each one builds and what to do after.

| Provider | Button reads | What runs | Persistent data |
|---|---|---|---|
| Google Cloud Run | `app.json` | the full server image, `deploy/containers/Dockerfile` | no: `/data` resets when an instance stops |
| Render | `render.yaml` | the full server image, root-volume variant (`deploy/containers/railway/Dockerfile`) | yes: 5 GB disk at `/data` |
| DigitalOcean App Platform | `.do/deploy.template.yaml` | the full server image, `deploy/containers/Dockerfile` | no: reset on every deploy |
| Koyeb | query parameters in the button URL | the full server image, `deploy/containers/Dockerfile` | no |
| Vercel | `vercel.json` | the site, web app and the HTTP API as a function (`npm run build:vercel`) | no; fetch-only providers, no yt-dlp or ffmpeg ([vercel.md](vercel.md)) |

"Full server image" means the HTTP API with yt-dlp, deno and ffmpeg, as described in [docker.md](docker.md). For a library that must survive restarts on a platform without a disk, set `DATABASE_URL` to a Postgres database (see [library-postgres.md](../guides/library-postgres.md)).

## Set an API key first

Every route except `/api/v1/health` is open until `VID2CONTEXT_API_KEYS` is set. Each button asks for it or generates it:

- **Cloud Run** generates a random key. Read it in the Cloud Run console, on the service's Variables and Secrets tab.
- **Render** generates a random key. Copy it from the service's Environment page.
- **DigitalOcean, Koyeb and Vercel** ask for it. Use a long random string, for example `openssl rand -hex 24`.

Clients send it as `Authorization: Bearer <key>`. A hashed entry (`name:scope:sha256`) keeps the key itself out of the provider's settings; see [cloud-run.md](cloud-run.md#one-time-setup) for how to make one. Add provider keys the same way, with the names from `.env.example`; all are optional.

Check the deploy:

```sh
curl https://<your app>/api/v1/health
curl -H "Authorization: Bearer $KEY" "https://<your app>/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw"
```

## Provider notes

- **Cloud Run:** the button runs in Cloud Shell. `build.skip` in `app.json` turns off the button's own build, and the `prebuild` hook builds `deploy/containers/Dockerfile` instead (the root `Dockerfile` is the small stdio MCP image for directory listings). The service gets 2 vCPU, 2 GiB, concurrency 4 and at most 3 instances, and scales to zero. The button cannot set a request timeout, so long transcriptions stop at Cloud Run's default of 300 seconds; raise it with `gcloud run services update vid2context --timeout 900`, or use the full setup in [cloud-run.md](cloud-run.md).
- **Render:** a persistent disk needs a paid instance type, so the Blueprint uses `1c-2g`. Render mounts the disk owned by root, which is why it builds the root-volume variant of the image that `deploy/containers/railway/gen-dockerfile.sh` generates. The server still runs as the `node` user. Auto-deploy is off, so your copy changes only when you deploy it.
- **DigitalOcean:** the spec uses `apps-s-1vcpu-2gb`. Pick a smaller size during creation if you only need captions.
- **Koyeb:** pick an instance with at least 1 GB of memory for speech-to-text; ffmpeg needs it.
- **Vercel:** Vercel installs with `npm ci --ignore-scripts` and runs `npm run build:vercel`, which writes the Build Output API tree to `.vercel/output/`. Deploying from your machine with `vercel deploy --prebuilt` still works the same way.

## No button

- **Railway:** a Railway button has to point at a template published from a Railway account, and this repository has none yet. Deploy with the CLI in [railway.md](railway.md).
- **Alibaba Cloud:** Function Compute buttons point at templates registered in its Application Center, and the function needs an image already pushed to your own Container Registry. Follow [alibaba.md](alibaba.md).
- **Cloudflare Workers:** the root `wrangler.jsonc` binds the `vid2context.com` custom domain, so a Deploy to Cloudflare button would fail in any other account. Follow [cloudflare.md](cloudflare.md) and remove the `routes` entry in your copy.

## YouTube

All of these run in datacenters, and YouTube blocks many datacenter IPs. Expect metadata to work and captions or downloads to be refused at times. The robust setup is the container on a home machine behind a [Cloudflare Tunnel](../guides/cloudflare-tunnel.md); see [docker.md](docker.md#youtube-and-datacenter-ips).
