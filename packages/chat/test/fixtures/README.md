# Chat test fixtures

All files are real recordings made on 2026-11-14. Nothing here is hand-written. No keys or personal data are included: provider keys in recordings were deliberately invalid, and the only IP address present is the probe page's own `127.0.0.1` origin.

| File | What | How it was recorded |
|---|---|---|
| `server-chat-cCPsdFdlshc.sse` | Raw `text/event-stream` body of `POST /api/v1/chat` (`meta`, `delta`, `done`), grounded in `https://www.youtube.com/watch?v=cCPsdFdlshc`. Answered by `llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free` after a Cloudflare rung failed with 401 (both in `done.attempts`). | `curl -N` against the local server (`PORT=<random> npx tsx packages/server/src/node.ts`, with packages/ask's `/chat` route) |
| `server-models.json` | `GET /api/v1/models?kind=llm` from the same server: `{ models: ModelInfo[], defaultPolicy }`. Only env var names, never values. | `curl` against the local server |
| `server-error-strict-disabled.json` | The 400 error body for `model: { rung: 'llm/groq/openai/gpt-oss-120b', strict: true }` on a server without `GROQ_API_KEY`, with the request that produced it. | `curl` against the local server |
| `server-error-no-context.json` | The 400 error body for a chat with nothing attached ("Nothing to ground the answer in."). | `curl` against the local server |
| `client-ovh-gpt-oss.json` | Client-only mode: the raw OVH `gpt-oss-120b` streaming response (reasoning and answer deltas, gpt-oss style `【n】` citations) plus the ChatEvents `localChat` emitted, grounded in `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`. | `npx tsx packages/chat/scripts/record-fixtures.ts` (keyless, no key) |
| `client-groq-bad-key.json` | Client-only mode: Groq's real 401 for a deliberately invalid key and the resulting `all-rungs-failed` error event with its attempt. | `npx tsx packages/chat/scripts/record-fixtures.ts` |
| `models-browser-nokeys.json` | `listModels(createRegistry(), {}, { kind: 'llm' })` over the browser registry: what a first-time visitor sees in client-only mode. | `npx tsx packages/chat/scripts/record-models.ts` |
| `models-browser-groq.json` | The same with `GROQ_API_KEY` and `GROQ_FALLBACK_KEYS` set to dummy values, to cover enabled and pooled-key rows. The output holds variable names only. | `npx tsx packages/chat/scripts/record-models.ts` |
| `cors-probe.json` | Which hosted LLM APIs let a web page call them: each endpoint called from a real Chromium 158 page on a local origin, with the headers its provider sends. | `node packages/chat/scripts/cors-probe.mjs > packages/chat/test/fixtures/cors-probe.json` |

Re-record after a provider or route changes, then review the diff for personal data before committing.
