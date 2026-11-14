# Railway

Railway builds the vid2context image from the repository and runs it with a volume for `/data`. Config: `deploy/containers/railway/railway.json`. Image details and env vars: [docker.md](docker.md).

## Why a separate Dockerfile

Railway refuses to build a Dockerfile that contains a `VOLUME` instruction, and mounts its volumes owned by root, while the image runs as the unprivileged `node` user. So Railway builds `deploy/containers/railway/Dockerfile`, which `deploy/containers/railway/gen-dockerfile.sh` generates from the main Dockerfile with three changes: no `VOLUME` line, the container starts as root, and `railway/entrypoint.sh` gives `/data` to `node` (once) and then drops root with `setpriv` before starting the server. The server process itself never runs as root. `deploy/containers/test.sh` fails when the generated file is stale.

## Deploy

Prerequisites: a Railway account and the CLI (`npm install -g @railway/cli`, or `brew install railway`).

```sh
railway login
railway init --name vid2context          # or: railway link, for an existing project
railway up --detach                       # first upload creates the service
```

Then, once per service:

1. **Config file.** In the service's Settings, under Config-as-code, set the path to `/deploy/containers/railway/railway.json`. Railway then builds with the Railway Dockerfile, checks `/api/v1/health` before switching traffic, and restarts on failure.
2. **Volume.** `railway volume add --mount-path /data`. The config sets `requiredMountPath: /data`, so a deploy without the volume fails instead of silently losing data.
3. **Variables.** Set `VID2CONTEXT_API_KEYS` before you add a public domain; without it every route is open:
   ```sh
   railway variables --set "VID2CONTEXT_API_KEYS=$(openssl rand -hex 24)"
   railway variables --set "GROQ_API_KEY=..."      # any variable from .env.example, all optional
   ```
   Railway injects `PORT`; the server listens on it.
4. **Domain.** `railway domain` creates a `*.up.railway.app` URL.
5. Deploy again: `railway up --detach`, then `curl https://<your domain>/api/v1/health`.

`railway up` uploads the working directory, skipping what `.gitignore` lists (so `.env` and `.vid2context/` stay local). To deploy from GitHub instead, connect the repository in the dashboard; the same config file applies.

## Notes

- Railway ignores the Dockerfile `HEALTHCHECK`; `healthcheckPath` in `railway.json` gates each deploy instead (120 s timeout, which covers a cold start).
- One volume per service and no replicas with a volume: this is a single-instance deploy. For several instances, keep the library in Postgres (`DATABASE_URL`, Railway has a Postgres template) and drop the volume requirement.
- Cost: Railway has no permanent free tier. New accounts get a one-time trial credit; after that the Hobby plan bills usage (CPU, memory, volume storage, egress) with a monthly minimum. An idle instance of this image uses roughly 100 MB of memory; ffmpeg and speech-to-text runs add CPU while they last. Check Railway's pricing page for current numbers.
- `railway.json` was validated against Railway's published schema (`deploy/containers/test.sh`). It has not been deployed from this repository yet: no Railway account was available while it was written.

## YouTube

Railway runs in datacenters, and YouTube blocks many datacenter IPs. Expect metadata to work and captions or downloads to be refused at times. The robust setup is the container on a home machine behind a [Cloudflare Tunnel](../guides/cloudflare-tunnel.md); see [docker.md](docker.md#youtube-and-datacenter-ips).
