# Docker

One image runs the vid2context HTTP API with everything the full feature set needs: yt-dlp (1000+ sites), deno (yt-dlp's JavaScript runtime for YouTube), ffmpeg, and optionally whisper.cpp for local speech-to-text. The same image deploys to [Railway](railway.md), [Cloud Run](cloud-run.md) and [Alibaba Cloud](alibaba.md).

Files: `deploy/containers/` (Dockerfile, compose file, platform configs, `test.sh`). The root `Dockerfile` is a different, smaller image: the MCP stdio server for directory listings.

## Build and run

Docker 23 or newer (BuildKit). From the repository root:

```sh
docker build -f deploy/containers/Dockerfile -t vid2context .
docker run -d --name vid2context -p 127.0.0.1:8787:8787 -v vid2context-data:/data --env-file .env vid2context
curl http://127.0.0.1:8787/api/v1/health
curl "http://127.0.0.1:8787/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw"
```

`--env-file .env` is optional: every key is optional (see `.env.example`). With none set you get YouTube captions plus the keyless speech-to-text and LLM rungs.

Hardened run, the way `test.sh` checks it:

```sh
docker run -d -p 127.0.0.1:8787:8787 -v vid2context-data:/data \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges vid2context
```

## What is in the image

| Piece | Version | How it is verified |
|---|---|---|
| Node | 24.22.2 on Debian 13 (trixie) slim | pinned base image tag |
| ffmpeg, ffprobe | Debian's package (7.1) | Debian's signed archive |
| yt-dlp | 2026.10.26, unpacked build in `/opt/yt-dlp` | the release's `SHA2-256SUMS`, whose own sha256 is pinned in the Dockerfile |
| deno | v2.9.8 | pinned sha256 per architecture |
| whisper.cpp (optional) | v1.9.5 | built from the tag, commit hash checked |
| tini | Debian's package | PID 1: reaps yt-dlp and ffmpeg children, forwards signals |

Only the server and what it imports go in: `@vid2context/server`, every provider that declares the `node` runtime, and their dependencies, installed with `npm ci --omit=dev --ignore-scripts` from `package-lock.json`. The build imports the generated registry once, so a provider with a missing entry file fails the build instead of the deploy.

**Why tsx and not plain Node.** Node 24 can strip TypeScript types itself, but only for "erasable" syntax. The code uses constructor parameter properties (`packages/core/src/telemetry/memory.ts`), which Node rejects with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. The image runs `node --import tsx packages/server/src/node.ts`: one process, the same transform `npm run start:server` uses in development, at the `tsx` version locked in `package-lock.json`.

**Why the unpacked yt-dlp.** The single-file yt-dlp unpacks its libraries into `/tmp` on every run. That fails when `/tmp` is mounted `noexec` (as `--tmpfs` does) and costs startup time on every call.

**Size**, measured on 2026-11-14 (uncompressed, linux/amd64):

| Image | Size |
|---|---|
| default | 1398 MB |
| `--build-arg WITH_WHISPER=1` | 1429 MB |

Debian's ffmpeg package and its libraries are 461 MB of that, node_modules 105 MB plus the transformers.js runtime for local speech-to-text (onnxruntime-node, trimmed to this platform), the unpacked yt-dlp 99 MB, deno 92 MB, Node 122 MB.

## Environment

The image sets these; override any with `-e`:

| Variable | Image value | Why |
|---|---|---|
| `HOST` | `0.0.0.0` | listen on the container network (the server's own default is 127.0.0.1) |
| `PORT` | `8787` | platforms that inject `PORT` (Railway, Cloud Run) override it |
| `VID2CONTEXT_HOME` | `/data` | library, models, media cache, managed files |
| `VID2CONTEXT_PUBLIC` | `1` | refuse local file paths as inputs. Set `0` only for a private container where you mount media |
| `YTDLP_PATH`, `YTDLP_AUTO_UPDATE` | `/opt/yt-dlp/yt-dlp`, `0` | use the verified copy; rebuild the image to update it |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Debian's binaries | no managed download (`VID2CONTEXT_FFMPEG_DOWNLOAD=0`) |
| `XDG_CACHE_HOME`, `DENO_DIR` | under `/data/cache` | yt-dlp and deno caches survive restarts and stay off the read-only root |

Set `VID2CONTEXT_API_KEYS` before exposing the port beyond your machine: without it every route is open. Provider keys are the same variables as in `.env.example`. Never bake keys into the image or pass them as build args; use `--env-file`, compose's `env_file`, or the platform's secret store.

## Volumes and writes

The process runs as the unprivileged `node` user (uid 1000) and writes only to `/data` (declared as a `VOLUME`) and `/tmp`, so `--read-only --tmpfs /tmp` works. Use a named volume (as above) or a bind mount owned by uid 1000. To transcribe your own files in a private container: `-e VID2CONTEXT_PUBLIC=0 -v "$PWD/media:/media:ro"`, then `?url=/media/talk.mp3&mode=stt`.

## whisper.cpp

```sh
docker build -f deploy/containers/Dockerfile --build-arg WITH_WHISPER=1 -t vid2context:whisper .
docker run --rm -v vid2context-data:/data vid2context:whisper \
  node --import tsx providers/stt-whisper-cpp/src/setup.ts --model base.en
docker run -d -p 127.0.0.1:8787:8787 -v vid2context-data:/data -e WHISPER_CPP_MODEL=base.en vid2context:whisper
```

The build compiles `whisper-cli` and `whisper-server` with one CPU backend per instruction set (`GGML_CPU_ALL_VARIANTS`), so the image runs well on any x86-64 or arm64 host, not only the build machine. Models are never in the image: the setup command downloads a verified model into `/data/models/whisper`. Tested on 2026-11-14: `tiny.en` transcribed the Apollo 11 clip in under a second, read-only root, no network rungs.

## Compose

```sh
docker compose -f deploy/containers/compose.yaml up -d --build
docker compose -f deploy/containers/compose.yaml --profile postgres --profile stt --profile ollama up -d
```

The server reads the repository's `.env` and runs read-only with all capabilities dropped. Each profile starts one local service. Compose cannot change the server's environment per profile, so point the server at a service by adding its line to `.env`, then `up -d` again:

| Profile | Service | Line for `.env` |
|---|---|---|
| `postgres` | `pgvector/pgvector:0.8.1-pg17` | `DATABASE_URL=postgres://vid2context:vid2context@postgres:5432/vid2context` (set `POSTGRES_PASSWORD` in your shell to change the password, and use it here) |
| `stt` | `speaches` 0.8.3, CPU | `LOCAL_STT_BASE_URL=http://stt:8000/v1` and `LOCAL_STT_MODEL=Systran/faster-whisper-small`; download the model once with `curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small` from inside the network (`docker compose exec server node -e "fetch('http://stt:8000/v1/models/Systran/faster-whisper-small',{method:'POST'}).then(r=>console.log(r.status))"`) |
| `ollama` | `ollama/ollama:0.40.13` | `OLLAMA_BASE_URL=http://ollama:11434/v1` and `OLLAMA_MODEL=qwen3:8b`, after `docker compose exec ollama ollama pull qwen3:8b` |

`WITH_WHISPER=1 docker compose ... up --build` builds the whisper.cpp variant. `VID2CONTEXT_BIND=0.0.0.0` publishes the port beyond loopback (set `VID2CONTEXT_API_KEYS` first).

## YouTube and datacenter IPs

YouTube blocks many datacenter and cloud IPs ("Sign in to confirm you're not a bot", or HTTP 429). A container on a laptop or home server uses your residential IP and works; the same container on a cloud host often gets only metadata, with captions and downloads refused. In a test from a cloud VM on 2026-11-14, YouTube answered 429 to both the innertube captions and yt-dlp's subtitle request, while yt-dlp still downloaded the audio. Robust options: run the container at home and publish it with a [Cloudflare Tunnel](../guides/cloudflare-tunnel.md) (see also [remote MCP](../guides/remote-mcp.md)), or keep a cloud deploy for other sites and uploaded media. YouTube cookies (`YTDLP_COOKIES_FILE`, see [the yt-dlp guide](../guides/ytdlp.md)) help but tie requests to an account.

## Checks

```sh
deploy/containers/test.sh                 # hadolint, compose config, platform configs, build, run checks
LIVE=1 deploy/containers/test.sh          # plus a real YouTube transcript and speech-to-text on the Apollo clip
deploy/containers/test.sh --whisper       # the whisper.cpp variant
deploy/containers/test.sh --lint-only     # configs only
```

The run checks start the image on a random port with `--read-only --tmpfs /tmp` and a temporary volume, then check health, the health check command, non-root uid, the read-only root, a writable `/data`, and that yt-dlp, deno, ffmpeg and ffprobe run.

## Updating pinned tools

Bump a build arg in `deploy/containers/Dockerfile`, then run `deploy/containers/railway/gen-dockerfile.sh` so the Railway copy follows. Use releases at least two weeks old.

```sh
# yt-dlp: the sha256 of the release's SHA2-256SUMS file
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/download/<version>/SHA2-256SUMS | sha256sum
# deno: one per architecture
curl -fsSL https://github.com/denoland/deno/releases/download/<version>/deno-x86_64-unknown-linux-gnu.zip | sha256sum
curl -fsSL https://github.com/denoland/deno/releases/download/<version>/deno-aarch64-unknown-linux-gnu.zip | sha256sum
# whisper.cpp: the commit the tag points to
git ls-remote https://github.com/ggml-org/whisper.cpp 'refs/tags/<version>^{}'
```
