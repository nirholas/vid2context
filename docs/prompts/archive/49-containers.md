# 49. Docker image and container deploys (Railway, Cloud Run, Alibaba Cloud)

| | |
|---|---|
| Track | I. Deploy and quality |
| You own | `deploy/containers/`, the root `.dockerignore` |
| Shared edits allowed | `docs/providers.md` and `.env.example` (deploy-only env vars, if any) |
| Commit scope | `deploy` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The full feature set (yt-dlp for 1000+ sites, ffmpeg for audio, local whisper.cpp) needs a real Linux environment, so the Node server ships as a container. The owner wants it to run everywhere: locally with Docker, on Railway, on Google Cloud Run (the owner already runs a GCP VM) and on Alibaba Cloud. This prompt builds one small, secure image and the deploy configs and guides for each platform.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md` (runtimes and deployment, and the YouTube datacenter-IP note).
2. `packages/server/src/node.ts`, `packages/server/package.json`, the root `package.json` (workspaces, scripts, engines), `tsconfig.base.json`.
3. `docs/providers.md` and `.env.example` (every env var the server may need; all optional).
4. `docs/contracts/http-api.md` (health route, auth via `VID2CONTEXT_API_KEYS`, CORS).
5. `docs/prompts/SHARED-CONTRACTS.md` sections 6 (URL layout), 8 and 9 (`.vid2context/` and `VID2CONTEXT_HOME`).

## Goal

`docker build -f deploy/containers/Dockerfile .` produces a small non-root image that serves the HTTP API with ffmpeg, deno and a pinned, checksum-verified yt-dlp inside, optional whisper.cpp, persistent data in a volume and a working health check; plus a compose file and deploy configs and guides for Railway, Cloud Run and Alibaba Cloud, each verified as far as this machine allows.

## Requirements

### Image

- Multi-stage `deploy/containers/Dockerfile`, Node 24 on Debian slim. Install production dependencies with `npm ci --omit=dev` for the workspaces the server needs (generate the registry with `npm run gen` during the build).
- Runtime: test whether Node runs the TypeScript server directly (`node packages/server/src/node.ts`, relying on Node's type stripping; imports use explicit `.ts` extensions) or needs `tsx`; choose what actually works and say why in the guide.
- Tools: ffmpeg from Debian, deno (yt-dlp's JS runtime for YouTube) from its official release with checksum, yt-dlp from its official GitHub release pinned by version with `SHA2-256SUMS` verification, `YTDLP_AUTO_UPDATE=0` in the image (the image is rebuilt instead), `FFMPEG_PATH` and `YTDLP_PATH` set.
- Optional whisper.cpp stage behind `--build-arg WITH_WHISPER=1`: build `whisper-cli` from the official source tag; models download at runtime into the data volume, never baked in.
- Non-root user, `VID2CONTEXT_HOME=/data` with `VOLUME /data` (SQLite library, models, media cache), `HOST=0.0.0.0`, `PORT` honoured (default 8787), `VID2CONTEXT_PUBLIC=1` by default (refuses local file inputs), `HEALTHCHECK` on `/api/v1/health`, an init process (`tini` or `--init` documented), read-only root filesystem compatible (writes only to `/data` and `/tmp`).
- No secrets in the image or build args. OCI labels (source, license Apache-2.0, version).
- Root `.dockerignore`: `node_modules`, `.git`, `.vid2context`, `dist`, `coverage`, `.env*` (except `.env.example`), test fixtures not needed at runtime.
- Measure and report the image size, with and without whisper.cpp.

### Compose

- `deploy/containers/compose.yaml`: the server with the `/data` volume and an `.env` file; optional profiles `postgres` (`pgvector/pgvector` image, `DATABASE_URL` wired), `stt` (speaches as a local OpenAI-compatible STT server, `LOCAL_STT_BASE_URL` wired), `ollama` (Ollama, `OLLAMA_BASE_URL` wired). Use env var names from `.env.example` exactly.

### Platforms

- Railway: `deploy/containers/railway/railway.json` using the Dockerfile, health check path, a volume for `/data`, and the guide's steps (`railway up`, variables).
- Cloud Run: `deploy/containers/cloud-run/service.yaml` (min instances 0, concurrency, CPU and memory sized for ffmpeg, timeout, `/data` on an in-memory or Cloud Storage FUSE volume with the tradeoff explained) and `deploy/containers/cloud-run/cloudbuild.yaml` (build, push to Artifact Registry, deploy). Secrets via Secret Manager references. Explain that YouTube often blocks Cloud Run egress IPs and point to the remote MCP and Cloudflare Tunnel guides (prompt 45) and to running the captions path from home.
- Alibaba Cloud: Function Compute custom container or SAE, with a Serverless Devs `deploy/containers/alibaba/s.yaml`, ACR push steps, and notes on region and egress.

## Out of scope

- The server code itself: prompt 46 (HTTP API). If the image needs a change in `packages/server`, report it rather than editing.
- Cloudflare, Vercel and GitHub Pages: prompt 50 (serverless and static).
- Release pipelines and npm bundles: prompt 38 (local CI and release).

## Tests

- When Docker is available: build the image, run it with a temporary volume on a random port, `curl /api/v1/health`, then (`LIVE=1`) request `/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw` and a speech-to-text run on the Apollo clip mounted into the container through keyless OVH Whisper (`VID2CONTEXT_PUBLIC=0` for that one check). Confirm the process runs as non-root and the root filesystem can be read-only (`--read-only --tmpfs /tmp`).
- `hadolint` on the Dockerfile and `docker compose config` on the compose file if available.
- A small test script `deploy/containers/test.sh` that performs these checks, so the owner can rerun them.

## Acceptance criteria

- [ ] `docker build -f deploy/containers/Dockerfile -t vid2context .` succeeds (or you report that Docker is unavailable here).
- [ ] The running container answers health, and a real transcript request in LIVE mode.
- [ ] Image size reported; non-root and read-only checks pass.
- [ ] Every platform config is syntactically valid (validated with the platform CLI where installed) and documented.

## Docs

- `docs/deploy/docker.md`, `docs/deploy/railway.md`, `docs/deploy/cloud-run.md`, `docs/deploy/alibaba.md`: prerequisites, exact commands, env vars, volumes, costs to expect on free tiers, and the YouTube IP caveat.

## If credentials, tools or network are missing

You cannot deploy to the owner's Railway, GCP or Alibaba accounts from here. Validate configs locally, and list every deploy step as not run. If Docker is not installed, write and lint what you can and report that the image was not built.

## Repo rules (binding, same as AGENTS.md)

- Never use the em-dash or en-dash characters: not in code, comments, docs, UI copy or commit messages. Use commas, colons, periods or parentheses. No emojis.
- No mocks, fake data, placeholders, TODOs, stub functions or "coming soon" text. If a piece cannot be built for real now, leave it out and say so in your final report.
- Tests use real data only: fixtures recorded from the real service, replayed through `replayFetch` and `testContext` from `@vid2context/core/testing`, or live calls gated by `LIVE=1` (`describe.skipIf(!process.env.LIVE)`). A unit test must never reach the network. Every fixture gets a line in its folder's `README.md` saying where and when it was recorded.
- Core code and providers never read `process.env` or the global `fetch`: use the `ctx` passed to every call. Log through `ctx.log` (stderr). stdout is program output and the MCP stdio channel.
- Prefer plain `fetch` over vendor SDKs. `packages/core` and every provider that declares the `workers` or `browser` runtime must not import Node built-ins.
- Every error a user can see is a `Vid2ContextError` with a stable `code` and a `hint` that says how to recover.
- Free first: local, then free tiers with the user's own key, then keyless hosts, and paid services last, only when their key is set. Every model id is overridable by env. New env vars go into `.env.example` and `docs/providers.md` in the same commit.
- Keep raw transcripts. Cleaned text, summaries, translations and briefs are added layers, never replacements.
- TypeScript, ESM, explicit `.ts` import extensions, Biome formatting (`npx biome check --write <your paths>`).

## Working in a shared folder

You are one of 50 agents working at the same time in this folder, each owning different directories.

- Create and edit files only inside the directories this prompt says you own, plus the shared edits listed in its header. Keep shared edits small and additive, and re-read a shared file immediately before every edit: another agent may have changed it a minute ago. `docs/prompts/SHARED-CONTRACTS.md` section 8 lists who may edit which shared file.
- If the foundation code differs from what this prompt describes, the code wins: read it and adapt. If something you need from another prompt has not landed yet, build everything else first and check again before you finish. If it is still missing, leave that piece out and list it in your report. Never stub it.
- Dependencies go only into your own package's `package.json`. Install through the shared lock so parallel installs cannot corrupt `node_modules`: `mkdir -p .vid2context/locks && flock .vid2context/locks/npm npm install -w <your package dir> <name>@<version>`. Never hand-edit `package-lock.json`; if it conflicts, rerun the install through the lock. Never edit `packages/registry/src/generated/`; run `npm run gen` instead.
- Other agents' unfinished work can break the repo-wide `npm run typecheck` and `npm test`. Judge your own paths: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E '<your dirs>'` prints nothing, `npx vitest run <your dirs>` passes, `npx biome check <your dirs>` is clean. Do not fix other agents' files; mention breakage you saw in your report.
- Never run commands that touch other agents' work: `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset`, `git checkout -- <path>`, `git restore`, `git clean`, `git rebase`, `git push`.
- Servers you start for testing: pick a random port between 20000 and 29999, and stop them when you are done.

## Committing

The owner asks you to commit your own work as described here. Commit each coherent piece as soon as it works, not only at the end.

1. `git status --short` and check that every path you will commit is yours.
2. `flock .vid2context/locks/git git add <explicit paths>` (needed for new files).
3. Commit only your paths, which leaves anything other agents staged untouched:
   `flock .vid2context/locks/git git commit -m "<type>(<scope>): <what changed and why it matters>" -m "<body: what and why, in plain language>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <explicit paths>`
   (use the Co-Authored-By trailer your harness specifies if it names a different model).
4. `git show --stat HEAD` and confirm only your files are in the commit.

Types: feat, fix, refactor, perf, test, docs, chore. Never use subjects like "update" or "wip". Do not push. Never amend or rewrite a commit you did not make.

## Final report

Finish with a short report to the owner: what you built (paths), what you verified live and how, what you could not verify and why (missing key, tool or network), every shared-file edit you made, what the integration pass needs to wire up, and any breakage you noticed outside your directories.
