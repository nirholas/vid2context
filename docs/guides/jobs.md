# Background jobs

Some work takes minutes: ingesting a 40-video playlist, transcribing a three-hour podcast, building a bundle over a series. `@vid2context/jobs` runs that work in the background, keeps it across restarts, streams progress to the web app, and lets users cancel it. On Node it runs in-process; on Cloudflare Workers and Google Cloud Run the same jobs run through Cloudflare Queues or Google Cloud Tasks.

## The job model

A job has a `kind` (what to do), an `input` and optional `options`. Its public shape is the `Job` from [contracts/http-api.md](../contracts/http-api.md#jobs):

```ts
interface Job {
  id: string;            // "job_" + 22 random URL-safe characters, never sequential
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  progress?: { done: number; total?: number; message?: string; retryAt?: string };
  result?: unknown;
  error?: { code: string; message: string; hint?: string };
  createdAt: string;
  updatedAt: string;
}
```

Input and options are stored with the job but not returned. Every change is written to a KvStore under `jobs:` keys, together with the job's most recent 500 events.

Built-in kinds:

| Kind | Input | Options | Result |
|---|---|---|---|
| `context` | one video URL or id | `mode`, `language`, `allowAuto`, `comments`, `refresh` | `{ video: VideoSummary, segments, url? }`; the full `VideoContext` is saved to storage |
| `items` | a playlist, channel or feed URL | the `context` options, plus `limit` (1 to 5000) and `concurrency` (1 to 8, default 2) | `{ input, total, succeeded, failed, items }`; succeeds when at least one video succeeded |
| `bundle` | a URL, or an array of up to 200 URLs (videos or lists) | the `items` options, plus `formats`, `maxTokens`, `name` | `{ filename, root, manifest, files, items }`, every bundle file as text (or base64 if not UTF-8) |

## Using it on Node

```ts
import { createContext } from '@vid2context/core';
import { createJobQueue, registerBuiltinKinds } from '@vid2context/jobs';
import { jobsRoutes } from '@vid2context/jobs/http';

const queue = createJobQueue({ registry, ctx: createContext({ runtime: 'node', env: process.env }), storage });
registerBuiltinKinds(queue);
app.route('/api/v1', jobsRoutes({ registry, makeCtx, storage: async () => storage, queue }));

const job = await queue.enqueue('items', 'https://www.youtube.com/playlist?list=PLDWrj3hS12VU', { limit: 10 });
```

Pass a long-lived `ctx`, not a request's: jobs outlive requests. Register kinds right after creating the queue; persisted jobs resume once the queue has started.

| Env var | Default | Meaning |
|---|---|---|
| `VID2CONTEXT_JOB_CONCURRENCY` | `2` | jobs that run at once; the rest wait in FIFO order |
| `VID2CONTEXT_JOB_TTL_HOURS` | `72` | finished jobs expire after this, through the KvStore TTL |
| `VID2CONTEXT_JOB_STALL_SEC` | `1800` | a running job with no progress or item event for this long is stopped (see below); `0` is off |
| `VID2CONTEXT_JOB_TIMEOUT_SEC` | `0` | longest one attempt may run; `0` is no limit |
| `VID2CONTEXT_MAX_QUEUED_JOBS` | `1000` | jobs waiting to run (queued or waiting to retry) before `enqueue` answers `rate-limited` with `retryAfterSec: 30` |

`items` and `bundle` never expand a list past `VID2CONTEXT_MAX_PLAYLIST_ITEMS` (default 500) videos, the same cap `GET /items` uses, whatever `limit` asks for. Without it, one channel URL could queue every upload the channel has.

## Stalled jobs

A handler that hangs, for example on an upstream that accepts the connection and never answers, would otherwise hold one of the runner's slots forever, and with the default concurrency of 2, two such jobs stop every job behind them. So every attempt is watched:

- **No progress.** An attempt that sends no `progress` or `item` event for `VID2CONTEXT_JOB_STALL_SEC` (30 minutes) is stopped. Report progress as you go and a slow job is never mistaken for a stuck one.
- **Too long.** With `VID2CONTEXT_JOB_TIMEOUT_SEC` set, an attempt that runs longer is stopped even while it reports progress.

Stopping aborts the handler's `signal` (so fetches and child processes that honour it end) and fails the attempt with a `timeout` error that names the last progress message. `timeout` is retried like any transient failure. The runner keeps the slot for up to 5 seconds while the aborted handler winds down, so the next job does not start while the old one still holds connections. A kind can set its own limits: `registerKind(kind, handler, { stallSec: 7200, timeoutSec: 0 })`, where 0 turns a check off.

A retry never waits more than an hour, even when an upstream sends a longer `Retry-After`.

## Registering a kind

```ts
queue.registerKind(
  'transcribe-long',
  async ({ input, options, signal, progress, item, registry, storage, ctx }) => {
    progress({ done: 0, total: 3, message: 'splitting' });
    // ... do the work, passing ctx (its signal aborts on cancel) to every provider call
    return { minutes: 180 };
  },
  { maxAttempts: 5, backoff: { baseMs: 5_000 } },
);
```

- Handlers must be idempotent: a job that was running when the process died runs again from the start. Save partial results to storage and skip what is already there (the built-in kinds get this for free, because saved contexts are cache hits).
- Throw a `Vid2ContextError`. `rate-limited`, `timeout`, `upstream` and `blocked` are retried with exponential backoff and jitter (`blocked` waits 15 minutes, since an IP block rarely clears sooner; a `Retry-After` from upstream is honored). Every other code, such as `bad-request`, `unsupported-input` or `not-found`, fails at once. Any other exception fails the job as `internal` without leaking its message.
- `maxAttempts` (default 3) counts every run, including the first.
- Unknown kinds are rejected at `enqueue` with `bad-request` and a hint listing the registered kinds.

## The live stream

`GET /api/v1/jobs/:id/events` is a Server-Sent Events stream with four events: `progress` `{ done, total?, message?, retryAt? }` (`retryAt` is set while a failed attempt waits for its retry: when the next attempt starts, ISO 8601, so a client can count down), `item` `{ id, outcome, title?, error? }`, `done` `{ result }` and `error` `{ code, message, hint? }`.

```sh
curl -s -X POST localhost:8787/api/v1/jobs -H 'content-type: application/json' \
  -d '{"kind":"items","input":"https://www.youtube.com/playlist?list=PLDWrj3hS12VU","options":{"limit":3}}'
# {"id":"job_...","kind":"items","status":"queued",...}

curl -N localhost:8787/api/v1/jobs/job_.../events
# id: 2
# event: progress
# data: {"done":0,"total":3,"message":"found 3 videos"}
#
# id: 5
# event: item
# data: {"id":"youtube:jNQXAC9IVRw","outcome":"ok","title":"Me at the zoo"}
# ...
# id: 12
# event: done
# data: {"result":{"input":"...","total":3,"succeeded":1,"failed":2,"items":[...]}}
```

- A new connection first replays the state (item events so far and the latest progress, or the final event of a finished job), then streams live events.
- Event ids are a per-job sequence. Browsers' `EventSource` sends `Last-Event-ID` when it reconnects, and the stream then resumes after that id with no duplicates.
- A `: heartbeat` comment is sent every 15 seconds so proxies keep the connection open. The stream closes after `done` or `error`.
- Each heartbeat also re-reads the job from the store, so a job run by another process (Cloud Tasks, Cloudflare Queues, a second server) still reaches the client, and the stream closes once that job is finished or has expired.
- `DELETE /api/v1/jobs/:id` cancels: a queued job never runs, a running job's `AbortSignal` fires. Either way the job ends `canceled` and the stream gets `error` with `code: 'canceled'`.

## Persistence and resume

The queue persists to `opts.kv`, else to the storage backend when it implements KvStore (SQLite, Postgres and Cloudflare D1 storage do), else to a process-local `MemoryKv` that is lost on restart. On start it lists every stored job: jobs left `running` by a crash go back to `queued`, and queued jobs run in creation order (a job waiting for a retry keeps its scheduled time). A running attempt rewrites its record every 30 seconds as a heartbeat, so a process that starts while another one sharing the store is still running a job leaves it alone. It takes the job over only once no heartbeat has arrived for 90 seconds, or once the other process hands it back on shutdown. After a crash, the job therefore resumes up to 90 seconds after the restart. `queue.close()` aborts running jobs and puts them back to `queued`, so a deploy loses nothing.

Events are published only after the state that contains them has been written, so a client that sees `done` and then reads `GET /jobs/:id` always sees the result.

## Cloudflare Queues

The Worker that serves the API is the producer, and the same Worker's `queue()` handler is the consumer. Job state lives in Workers KV (or D1 through the D1 storage provider, which is strongly consistent; Workers KV can lag up to 60 seconds between locations).

```sh
npx wrangler queues create vid2context-jobs
npx wrangler queues create vid2context-jobs-dlq
npx wrangler kv namespace create JOBS_KV
```

Add to `wrangler.jsonc`:

```jsonc
{
  "kv_namespaces": [{ "binding": "JOBS_KV", "id": "<id printed by the command above>" }],
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "vid2context-jobs" }],
    "consumers": [
      { "queue": "vid2context-jobs", "max_batch_size": 1, "max_retries": 5, "dead_letter_queue": "vid2context-jobs-dlq" }
    ]
  }
}
```

```ts
import { cloudflareDispatch, JobKinds, queueConsumer, RemoteQueue, registerBuiltinKinds, workersKv } from '@vid2context/jobs';
import { jobsRoutes } from '@vid2context/jobs/http';

const kinds = new JobKinds();
registerBuiltinKinds(kinds);

export default {
  fetch(req: Request, env: Env) {
    const queue = new RemoteQueue({ kv: workersKv(env.JOBS_KV), dispatch: cloudflareDispatch(env.JOBS), ctx: makeCtx(req, env), kinds });
    // mount jobsRoutes({ ..., queue }) on the app and serve req
  },
  queue: queueConsumer((env: Env) => ({ kv: workersKv(env.JOBS_KV), kinds, registry, ctx: backgroundCtx(env) })),
};
```

Each message is `{ jobId }`. The consumer acks once the job reaches a final state, calls `message.retry({ delaySeconds })` with the job's own backoff when the job asks for a retry (Queues caps delays at 12 hours), and lets Cloudflare retry when the store itself failed. Keep `max_retries` at least `maxAttempts - 1`; a job whose messages end in the dead-letter queue stays `queued` until you resubmit it. On the producer side `subscribe` polls the store once a second, so the SSE stream works across isolates. Consumer invocations are limited to 15 minutes of wall time, so split longer work into several jobs.

## Google Cloud Tasks

For Cloud Run (or any HTTPS host on GCP), jobs are HTTP tasks that POST to `POST /api/v1/jobs/:id/run` with an OIDC token. The run endpoint exists only when you configure it, and it verifies the token's signature against Google's published keys (fetched through `ctx.fetch` and cached for their `max-age`), its issuer, its audience, its expiry and the service account email. Job state must live in a store every instance shares: the Postgres storage provider implements KvStore.

```sh
PROJECT=my-project REGION=us-central1 SERVICE=vid2context
gcloud tasks queues create vid2context-jobs --location=$REGION \
  --max-attempts=5 --min-backoff=10s --max-backoff=600s --max-concurrent-dispatches=4
gcloud iam service-accounts create vid2context-tasks
# Cloud Tasks signs as this account; it may invoke the service.
gcloud run services add-iam-policy-binding $SERVICE --region=$REGION \
  --member=serviceAccount:vid2context-tasks@$PROJECT.iam.gserviceaccount.com --role=roles/run.invoker
# The service's own runtime account creates tasks and acts as the invoker account.
gcloud projects add-iam-policy-binding $PROJECT \
  --member=serviceAccount:<runtime-account> --role=roles/cloudtasks.enqueuer
gcloud iam service-accounts add-iam-policy-binding vid2context-tasks@$PROJECT.iam.gserviceaccount.com \
  --member=serviceAccount:<runtime-account> --role=roles/iam.serviceAccountUser
```

```sh
VID2CONTEXT_CLOUD_TASKS_QUEUE=projects/my-project/locations/us-central1/queues/vid2context-jobs
VID2CONTEXT_CLOUD_TASKS_RUN_URL=https://vid2context-xyz.a.run.app/api/v1
VID2CONTEXT_CLOUD_TASKS_SERVICE_ACCOUNT=vid2context-tasks@my-project.iam.gserviceaccount.com
# VID2CONTEXT_CLOUD_TASKS_AUDIENCE defaults to the run URL
```

```ts
import { cloudTasksConfigFromEnv, cloudTasksDispatch, GoogleOidcVerifier, JobKinds, RemoteQueue, registerBuiltinKinds } from '@vid2context/jobs';

const cfg = cloudTasksConfigFromEnv(env);
if (cfg) {
  const dispatch = cloudTasksDispatch(cfg, ctx); // access tokens from the metadata server
  const queue = new RemoteQueue({ kv, dispatch, ctx, kinds });
  const verifier = new GoogleOidcVerifier({ audience: cfg.audience ?? cfg.runUrl, serviceAccountEmail: cfg.serviceAccountEmail });
  app.route('/api/v1', jobsRoutes({ registry, makeCtx, storage, queue, run: { verifier, dispatch, consumer: (c) => ({ kv, kinds, registry, storage, ctx: c }) } }));
}
```

Each task has a 30-minute dispatch deadline (the maximum for HTTP targets) and is scheduled for the job's backoff when it is a retry. The run endpoint answers `200` for every outcome the job decided itself (so Cloud Tasks does not retry on top of the job's own backoff) and `5xx` only when running failed, which Cloud Tasks then retries with the queue's settings.
