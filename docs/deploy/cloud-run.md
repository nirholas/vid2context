# Google Cloud Run

Cloud Run runs the vid2context image on demand and scales to zero when idle. Configs: `deploy/containers/cloud-run/service.yaml` (the service) and `deploy/containers/cloud-run/cloudbuild.yaml` (build, push to Artifact Registry, deploy). Image details and env vars: [docker.md](docker.md).

## The service

| Setting | Value | Why |
|---|---|---|
| min / max instances | 0 / 3 | no cost when idle; raise max for more traffic |
| CPU, memory | 2 vCPU, 2 GiB | ffmpeg and yt-dlp are CPU-bound; memory also holds the in-memory `/data` |
| concurrency | 4 | caption requests are light, speech-to-text runs ffmpeg; 4 keeps one instance responsive |
| request timeout | 900 s | long videos: download, convert and transcribe |
| startup CPU boost, gen2 | on | faster cold starts; gen2 is required for the volume types below |
| `/data` | in-memory volume, 512 MiB | see below |
| `VID2CONTEXT_API_KEYS` | Secret Manager `vid2context-api-keys` | required before the URL is public |

**`/data`: memory or Cloud Storage.** The default is an in-memory volume: fast and free, but empty on every new instance and counted against the 2 GiB. It holds caches well; saved contexts vanish when the instance stops. A Cloud Storage FUSE volume (commented in `service.yaml`) survives restarts and is good for downloaded models and media, but every file operation is a network call and SQLite's locking does not work on it, so never put `library.db` there. For a library that must persist, use Postgres (`DATABASE_URL`, for example Cloud SQL or a Neon free database) with the in-memory volume for caches.

## One-time setup

```sh
PROJECT_ID="$(gcloud config get-value project)"
REGION=us-central1
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com
gcloud artifacts repositories create vid2context --repository-format=docker --location="$REGION"
gcloud iam service-accounts create vid2context-run --display-name "vid2context on Cloud Run"
RUN_SA="vid2context-run@$PROJECT_ID.iam.gserviceaccount.com"
```

API keys as a secret. Store a hashed entry (`name:scope:sha256`) so the key itself is never in Google's config, and keep the key for your clients:

```sh
KEY="$(openssl rand -hex 24)"; echo "your API key: $KEY"
printf '%s' "client:read:$(printf %s "$KEY" | sha256sum | cut -d' ' -f1)" \
  | gcloud secrets create vid2context-api-keys --data-file=-
gcloud secrets add-iam-policy-binding vid2context-api-keys \
  --member="serviceAccount:$RUN_SA" --role=roles/secretmanager.secretAccessor
```

Use `write` or `admin` instead of `read` for keys that may change the library (see `docs/contracts/http-api.md`). Provider keys work the same way: create a secret, grant access, uncomment its block in `service.yaml`.

Let Cloud Build deploy as the runtime service account:

```sh
BUILD_SA="$(gcloud builds get-default-service-account --format='value(serviceAccountEmail)' | sed 's#.*/##')"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$BUILD_SA" --role=roles/run.admin
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" \
  --member="serviceAccount:$BUILD_SA" --role=roles/iam.serviceAccountUser
```

## Deploy

```sh
gcloud builds submit --config deploy/containers/cloud-run/cloudbuild.yaml --substitutions "_REGION=$REGION"
```

Substitutions: `_REGION`, `_REPOSITORY` (vid2context), `_SERVICE` (vid2context), `_SERVICE_ACCOUNT` (vid2context-run), `_WITH_WHISPER` (`1` adds whisper.cpp), `_DATA_BUCKET` (only with the Cloud Storage volume). Each build tags the image with the build id and `latest`, and deploys the build id.

Without Cloud Build, from your machine:

```sh
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/vid2context/vid2context:$(git rev-parse --short HEAD)"
gcloud auth configure-docker "$REGION-docker.pkg.dev"
docker build --platform linux/amd64 -f deploy/containers/Dockerfile -t "$IMAGE" . && docker push "$IMAGE"
IMAGE="$IMAGE" SERVICE_ACCOUNT="$RUN_SA" envsubst '$IMAGE $SERVICE_ACCOUNT' \
  < deploy/containers/cloud-run/service.yaml > /tmp/service.yaml
gcloud run services replace /tmp/service.yaml --region "$REGION"
```

## Access

The service starts private: only principals with `roles/run.invoker` can call it. To test it while private, send Google's identity token in `X-Serverless-Authorization`, which leaves `Authorization` free for the vid2context key:

```sh
URL="$(gcloud run services describe vid2context --region "$REGION" --format='value(status.url)')"
curl -H "X-Serverless-Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/api/v1/health"
```

To make it public (the API keys then protect every route except `/api/v1/health`):

```sh
gcloud run services add-iam-policy-binding vid2context --region "$REGION" \
  --member=allUsers --role=roles/run.invoker
curl -H "Authorization: Bearer $KEY" "$URL/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw"
```

## Costs on the free tier

- Cloud Run (request-based billing) includes, per month, 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests. At 2 vCPU and 2 GiB that is about 25 hours of instance time while requests run; idle time at zero instances costs nothing.
- Cloud Build includes 2,500 build-minutes a month on the default machine, which `cloudbuild.yaml` uses. A build with whisper.cpp takes noticeably longer.
- Artifact Registry includes 0.5 GB of storage. Each pushed image is several hundred MB compressed, so add a cleanup policy that keeps the last few tags.
- Secret Manager includes 6 active secret versions and 10,000 access operations a month.

Check Google's pricing pages for current numbers; free tiers change.

## YouTube

YouTube often blocks Cloud Run's egress IPs: expect metadata to work and captions or audio downloads to fail with "blocked" or HTTP 429 at times. A static egress IP through Cloud NAT does not help, since it is still a Google datacenter address. Robust options:

- Run the captions path from home: the same container on a home machine, published with a [Cloudflare Tunnel](../guides/cloudflare-tunnel.md), and agents connected through [remote MCP](../guides/remote-mcp.md).
- Keep Cloud Run for other sites, uploaded media and the LLM features, and send YouTube URLs to the home deploy.

## What was verified

On 2026-11-14 `service.yaml` and `cloudbuild.yaml` parsed as YAML, and the deploy step's rendering was run locally and produced a valid service file. Nothing was deployed to Google Cloud: running the build and deploy needs the owner's project.
