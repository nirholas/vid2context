# Alibaba Cloud

Two ways to run the vid2context image on Alibaba Cloud:

| | Function Compute 3.0 (custom container) | Serverless App Engine (SAE) |
|---|---|---|
| Model | per request, scales to zero | long-running instances |
| Config | `deploy/containers/alibaba/s.yaml` (Serverless Devs) | console or `aliyun` CLI |
| Good for | occasional use, captions, short videos | steady traffic, long transcriptions, a persistent library |

Image details and env vars: [docker.md](docker.md).

## Region and egress

- Use a region outside mainland China, such as `ap-southeast-1` (Singapore, the default in `s.yaml`), `cn-hongkong` or `us-west-1`. Mainland regions cannot reach YouTube or many other video sites, and a public endpoint there needs an ICP filing.
- Function Compute's outbound address is shared and changes. For a fixed egress IP, attach a VPC with a NAT gateway (`vpcConfig` in `s.yaml`); that costs extra and does not help with YouTube.
- YouTube blocks many datacenter IPs, Alibaba's included: expect metadata to work and captions or downloads to be refused at times. The robust path for YouTube is the container at home behind a [Cloudflare Tunnel](../guides/cloudflare-tunnel.md); see [docker.md](docker.md#youtube-and-datacenter-ips).

## Push the image to ACR

Container Registry (ACR) Personal Edition is free. In the ACR console for your region, create the instance if asked, a namespace, and set a registry password. Then:

```sh
export ALIBABA_REGION=ap-southeast-1
export ACR_NAMESPACE=...            # the namespace you created
export ACR_IMAGE="registry.$ALIBABA_REGION.aliyuncs.com/$ACR_NAMESPACE/vid2context:0.1.0"
docker login --username=<your Alibaba Cloud account name> "registry.$ALIBABA_REGION.aliyuncs.com"
docker buildx build --platform linux/amd64 -f deploy/containers/Dockerfile -t "$ACR_IMAGE" --push .
```

Function Compute pulls from ACR in the same region. Keep the repository private.

## Function Compute

Install Serverless Devs and add an AccessKey of a RAM user with `AliyunFCFullAccess` and `AliyunContainerRegistryReadOnlyAccess`:

```sh
npm install -g @serverless-devs/s
s config add          # interactive: choose Alibaba Cloud, alias "default"
```

Deploy:

```sh
KEY="$(openssl rand -hex 24)"; echo "your API key: $KEY"
export VID2CONTEXT_API_KEYS="client:read:$(printf %s "$KEY" | sha256sum | cut -d' ' -f1)"
s deploy -t deploy/containers/alibaba/s.yaml -y
s info -t deploy/containers/alibaba/s.yaml       # shows the HTTP trigger URL
curl -H "Authorization: Bearer $KEY" "https://<trigger domain>/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw"
```

`s.yaml` reads `ACR_IMAGE` and `VID2CONTEXT_API_KEYS` from your shell, plus optional `ALIBABA_REGION`, `ALIBABA_ACCESS` (credential alias, default `default`) and `FC_FUNCTION_NAME`. Set `VID2CONTEXT_API_KEYS` every time you deploy: the HTTP trigger is anonymous, so the keys are what protects the API. The hashed form keeps the key itself out of the function's configuration.

The function: 2 vCPU, 4 GB memory, 900 s timeout, 4 concurrent requests per instance, health check on `/api/v1/health`, data on the temporary disk (`VID2CONTEXT_HOME=/tmp/vid2context`, 512 MB). Instances are ephemeral, so the library and downloaded models do not survive. To keep them, mount NAS (`nasConfig`) or OSS (`ossMountConfig`) and point `VID2CONTEXT_HOME` at the mount; as on any network filesystem, keep SQLite's `library.db` off OSS and use Postgres (`DATABASE_URL`, ApsaraDB RDS for PostgreSQL) for a shared library.

Large images start slower on a cold start; ACR Enterprise Edition's image acceleration helps if that matters.

## Serverless App Engine

SAE runs the same image as an always-on application, without Function Compute's per-request timeout:

1. In the SAE console, create an application in the same region, deployment method "Image", and pick `$ACR_IMAGE`.
2. Port 8787, 2 cores and 4 GB, at least one instance.
3. Environment variables: `VID2CONTEXT_API_KEYS` (better: an SAE secret), plus any provider keys from `.env.example`.
4. Health checks (liveness and readiness): HTTP GET `/api/v1/health` on port 8787.
5. Storage: mount NAS at `/data` to keep the library and models across restarts.
6. Bind a public SLB or CLB for internet access.

## Costs

- ACR Personal Edition: free.
- Function Compute bills per vCPU-second, GB-second and request, and new accounts get a trial quota. An idle function costs nothing; the temporary disk is free up to 512 MB.
- SAE bills per instance-minute while instances run, so one always-on instance is a fixed monthly cost.

Check Alibaba Cloud's pricing pages for current numbers.

## What was verified

On 2026-11-14 the `fc3` props in `s.yaml`, with its variables resolved, validated against the published schema of the Serverless Devs `fc3` component (`deploy/containers/test.sh`). Nothing was deployed to Alibaba Cloud: no account was available, and `s` was not installed here.
