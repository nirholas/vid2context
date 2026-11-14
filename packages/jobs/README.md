# @vid2context/jobs

Background jobs for vid2context: a persistent in-process queue with retries, cancellation and live SSE progress, built-in `context`, `items` and `bundle` kinds, the `/jobs` HTTP routes, and adapters for Cloudflare Queues and Google Cloud Tasks. Guide: [docs/guides/jobs.md](../../docs/guides/jobs.md).

## API

| Export | What it does |
|---|---|
| `createJobQueue({ registry, ctx, storage?, kv?, concurrency?, ttlHours? })` | In-process `JobQueue` for Node. Persists to `kv`, else to `storage` when it implements KvStore, else to a `MemoryKv`. Resumes stored jobs on start |
| `JobQueue` | `registerKind`, `kinds`, `enqueue`, `get`, `list`, `cancel`, `subscribe`, `snapshot`, `close` |
| `registerBuiltinKinds(queue)` | Registers `context`, `items` and `bundle` (works on a queue or a `JobKinds` table) |
| `jobsRoutes(deps)` (from `@vid2context/jobs/http`) | Hono sub-app: `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/events`, `DELETE /jobs/:id`, and `POST /jobs/:id/run` when `deps.run` is set. Mount under `/api/v1` |
| `toSSE(queue, id, { lastEventId?, heartbeatMs?, signal? })` | The event stream as a `Response`: replay, live events, heartbeats, `Last-Event-ID` resume |
| `RemoteQueue({ kv, dispatch, ctx, kinds? })` | Producer for serverless runners: persists, dispatches the id, follows progress by polling the store |
| `runDispatchedJob(id, deps)` | Consumer body: runs one attempt, aborts on a cancel request, returns the outcome |
| `cloudflareDispatch(queue)`, `handleQueueBatch(batch, env, setup)`, `queueConsumer(setup)`, `workersKv(namespace)` | Cloudflare Queues producer and consumer, and a KvStore over Workers KV |
| `cloudTasksConfigFromEnv(env)`, `buildCloudTask(cfg, job, delayMs?)`, `cloudTasksDispatch(cfg, ctx)`, `GoogleOidcVerifier` | Google Cloud Tasks producer and OIDC token verification for the run endpoint |
| `JobKinds`, `runJob`, `retryDelayMs`, `RETRYABLE_CODES` | Building blocks for other runners |

Env: `VID2CONTEXT_JOB_CONCURRENCY` (default 2), `VID2CONTEXT_JOB_TTL_HOURS` (default 72), and the `VID2CONTEXT_CLOUD_TASKS_*` variables (see `docs/providers.md`).

## Tests

`npx vitest run packages/jobs` replays recorded YouTube responses (see `test/fixtures/README.md`) through the real pipeline, serves the routes from a real `@hono/node-server`, and runs the Cloudflare consumer inside workerd through Miniflare. `LIVE=1` adds an items job over a real playlist streamed over SSE, and Cloud Tasks token checks against a real Google-issued token (on a GCP machine whose metadata server issues identity tokens).
