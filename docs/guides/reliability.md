# Reliability: what can stall or take vid2context down

An audit of hang and crash risks per surface, with the file and line where each one lives (line numbers as of 2026-11-15), and what was done about it. "Fixed" means the change and a test are in the tree; "open" means it is known and left for the owner of that code.

Every limit below has an env var with a safe default. They are listed in `.env.example` and [docs/providers.md](../providers.md).

## HTTP server (`packages/server`)

| Risk | Evidence | Status |
|---|---|---|
| The timeout middleware answered 504 but left the work running; only `ctx.signal` stops it. | `src/middleware.ts:127` races `next()`; `src/services.ts:142` folds `AbortSignal.timeout` into `ctx.signal` | Fixed earlier (deadline in `ctx.signal`), 499 for client aborts in `src/errors.ts` |
| No cap on concurrent expensive requests (context, transcript, pack, bundle, ask, briefs, MCP tool calls): a burst runs every pipeline at once and exhausts memory, sockets and yt-dlp slots. | routes mount with no limiter, `src/app.ts` | Fixed: `src/concurrency.ts` (`VID2CONTEXT_MAX_CONCURRENT`, `VID2CONTEXT_MAX_WAITING`, `VID2CONTEXT_QUEUE_WAIT_MS`), 503 `busy` with `Retry-After` |
| `/api/v1/health` is liveness only: a container whose storage, disk or binaries are broken still looks healthy. | `src/app.ts:267` | Fixed: `GET /healthz` and `/healthz?deep=1` (also `/api/v1/healthz`) check storage, rungs, disk space, yt-dlp, ffmpeg and the keyless network; 503 when a required check fails (`VID2CONTEXT_HEALTH_REQUIRE`), cached and single-flight (`src/health.ts`, `src/health-node.ts`) |
| Shutdown waited for `server.close()`, which never resolves while an SSE client (job events, MCP GET stream) stays connected, so such deploys ended in the forced `exit(1)`. | `src/node.ts:68` (before) | Fixed: `src/lifecycle.ts` `gracefulClose` gives requests half of `VID2CONTEXT_SHUTDOWN_TIMEOUT_MS`, closes MCP sessions, jobs and downloads, then cuts what is still open |
| An unhandled promise rejection anywhere in the process exits Node 22 and ends every in-flight request. | `src/node.ts` had no handler | Fixed: logged with the stack, the process keeps serving (`VID2CONTEXT_EXIT_ON_UNHANDLED=1` restores the exit) |
| Slow clients (slowloris) could hold sockets; Node's defaults were not configurable and are only checked every 30 s. | `src/node.ts:50` (before) | Fixed: `VID2CONTEXT_HEADERS_TIMEOUT_MS`, `VID2CONTEXT_BODY_TIMEOUT_MS`, `VID2CONTEXT_KEEPALIVE_TIMEOUT_MS`, passed at server creation with a matching check interval |
| Request bodies: JSON routes are capped by `bodyLimit` (`VID2CONTEXT_MAX_BODY_KB`), uploads by `VID2CONTEXT_MAX_UPLOAD_MB`, `/imports` caps its own at 5 MB. `/mcp` and `/oauth/*` are outside `/api/*` and had no cap. | `src/middleware.ts:179`, `packages/mcp-http/src/routes.ts` | Fixed in mcp-http (below) |
| Large transcripts: responses are built in memory (`JSON.stringify`, ETag hash). Bounded by `VID2CONTEXT_MAX_SEGMENTS` (200000) in core, which keeps one response to tens of MB. | `src/http-util.ts` `jsonWithEtag` | Acceptable; no change |
| Single-flight runs use their own timeout signal, so a run nobody waits for any more still runs to its deadline (it fills the cache). | `src/services.ts:206` | Acceptable by design |

## Remote MCP (`packages/mcp-http`) and stdio MCP (`packages/mcp`)

| Risk | Evidence | Status |
|---|---|---|
| `POST /mcp` and the OAuth form posts read the whole body with no size limit. | `src/transport.ts:106`, `src/oauth.ts` | Fixed: `VID2CONTEXT_MCP_MAX_BODY_KB` (default 1024), 413 before the SDK parses |
| Session mode builds the server with no signal, so a tool call has no deadline of its own; only the client's `notifications/cancelled` or the session closing stops it. | `src/transport.ts:132` | Open: needs a per-call deadline inside `@vid2context/mcp` tool wrappers (item 44) |
| Idle sessions are swept (`VID2CONTEXT_MCP_SESSION_IDLE_SEC`), at most 256 kept. | `src/transport.ts` | Fine |
| stdio: no SIGTERM or stdin-close handler; the process exits when stdin ends because nothing else holds the loop. | `packages/mcp/src/bin.ts:32` | Fine; noted |

## Jobs (`packages/jobs`)

Hardened in this round by another session (stall and per-attempt timeouts, a cap on queued jobs, a Retry-After clamp, the slot held on abort); see `packages/jobs` and [jobs.md](jobs.md). Findings from this audit passed to that owner:

| Risk | Evidence | Status |
|---|---|---|
| A handler that never settles and ignores its signal holds a concurrency slot forever. | `src/execute.ts:153` `raceAbort` only rejects on abort | Fixed: the stall watchdog aborts it, the slot is freed after a 5 s grace (`src/watchdog.ts`) |
| On start, every `running` record is requeued, including jobs another live process sharing the store is still running (no heartbeat on the record). | `src/queue.ts:126` | Fixed: running attempts heartbeat every 30 s; a fresh `running` record is watched and taken over only when stale or handed back |
| `enqueue` grows `pending` without bound. | `src/queue.ts:144` | Fixed: `VID2CONTEXT_MAX_QUEUED_JOBS` (1000), then `rate-limited` |
| `close()` aborts running jobs at once instead of draining them. | `src/queue.ts:193` | Jobs owner; the server's shutdown gives it half the grace period before cutting connections |
| Cloud Tasks token, enqueue and JWKS fetches use `ctx.fetch` with no timeout. | `src/cloud-tasks.ts:85`, `:104`, `:200` | Fixed: 15 s deadline, then `timeout` |
| The SSE heartbeat timer writes into the stream without a try; a write after the consumer is gone throws from a timer. | `src/sse.ts:127` | Fixed: a failed write ends the stream |

## yt-dlp provider (`providers/ytdlp`)

| Risk | Evidence | Status |
|---|---|---|
| A request aborted while waiting for a `YTDLP_CONCURRENCY` slot stayed in the wait list; when woken it took the slot and spawned yt-dlp anyway, because an abort listener added after the abort never fires. The process then ran to its full timeout. The wait list was unbounded. | `src/process.ts:54`, `:57`, `:136` (before) | Fixed: waiters leave the queue on abort and slots pass to the next live waiter; spawn checks the signal; `YTDLP_MAX_WAITING` (64) refuses more as busy. Timeout hints name the caller's env var (`timeoutEnvVar`) |
| YouTube changes break extraction until the weekly update check runs. | `src/binary.ts:23` (weekly), `src/errors.ts:90` | Fixed: an extractor error that yt-dlp marks as needing an update ("Confirm you are on the latest version using yt-dlp -U", recorded from yt-dlp 2023.03.04 against YouTube and Vimeo) triggers an immediate checksum-verified update of the managed binary, at most once per `YTDLP_SELF_UPDATE_MIN_SEC` (default 6 h) across processes, and one retry. The hint says whether it updated, was already latest, was too soon, or is a user binary |
| An old binary is invisible until it breaks. | `packages/cli/src/doctor/run.ts` | Fixed: `doctor` and `/healthz?deep=1` warn when yt-dlp is older than `YTDLP_STALE_DAYS` (default 60) |
| Every child has a timeout, kills its process group on abort and caps stdout and stderr. | `src/process.ts` | Fine |

## Rung chain (`packages/core/src/chain.ts`)

Owned by another session in this round. The per-rung timeout (`VID2CONTEXT_RUNG_TIMEOUT_MS`, default 180 s, local rungs exempt) and the stop-on-abort check before each rung are in `chain.ts`. Remaining risk: a timed-out rung's call keeps running until the request signal ends, because `runChain` cannot hand the call a signal of its own without a change to the `call(rung)` signature in `pipeline.ts`.

## STT and LLM providers (not changed here)

| Risk | Evidence | Status |
|---|---|---|
| Most providers use `fetchWithTimeout` (default `VID2CONTEXT_FETCH_TIMEOUT_MS`). | `packages/core/src/context.ts:88` | Fine |
| `stt-transformers` on Node fetches remote audio and runs ffmpeg with only `ctx.signal`, no timeout, and collects decoded PCM without a cap. | `providers/stt-transformers/src/node.ts` | Open, for that provider's owner |
| whisper.cpp and ffmpeg runners have timeouts and kill on abort. | `providers/stt-whisper-cpp/src/exec.ts`, `packages/ffmpeg/src/process.ts` | Fine |

## Storage and web app

| Risk | Evidence | Status |
|---|---|---|
| Storage is opened once per process and shared; a failed open is retried on the next request. | `packages/server/src/services.ts` | Fine; the deep health check now writes and reads a probe key |
| The web app's calls have no client-side timeout and rely on the server's deadline (`VID2CONTEXT_REQUEST_TIMEOUT_MS`). | `packages/web/src/lib/api.ts` | Fine while the server deadline holds |
