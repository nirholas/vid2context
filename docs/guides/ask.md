# Ask and chat

`@vid2context/ask` answers questions about one video, several videos or a collection. Every factual sentence of the answer cites a numbered source as `[n]`, and every source is a timestamp link to the moment of the video that supports it. It powers `POST /api/v1/ask`, `POST /api/v1/chat` (the chat page) and the MCP `ask` tool.

```ts
import { ask } from '@vid2context/ask';
const r = await ask(registry, { question: 'Which G-Wagon years have the M113 engine?', inputs: ['https://www.youtube.com/watch?v=cCPsdFdlshc'], storage }, ctx);
r.answer;     // "The 2000 G500 uses the M113 V8 [2]. ..."
r.citations;  // [{ n: 2, videoId, title, startSec: 64.3, endSec, url: '...&t=64s', quote: '...' }]
```

`askStream()` yields the same answer as events. `prepareAsk()` plus `streamAnswer()` are the two halves, for servers that must reject a bad request before they start streaming.

## What gets grounded

- `inputs`: URLs, ref ids (`youtube:abc`) or `upload:<sha256>`. Each goes through `getVideoContext` with the storage passed in, so a saved context is reused and a new one is saved.
- `collectionId`: every saved video of the collection.
- `contexts`: `VideoContext` objects you already have. They are searched in memory and are not saved to the library.

## Retrieval

Each transcript is cut into chunks of about 30 to 90 seconds with core's `chunkTranscript` in time mode (60 second target, cuts on sentence ends or pauses, never inside a segment). Short chunks are what let a citation open the video near the right second.

1. The source budget comes from the first rung's context window: 90 percent of the window, minus the instructions, the history and the answer (`maxTokens`, default 2048), capped by `maxSourceTokens` (default 32000).
2. When every chunk of every video fits, all of them are sent. Nothing is lost and no query is needed.
3. Otherwise chunks are ranked by keyword hits from `storage.search` (stopwords dropped). When the storage implements `VectorStore` and an embedding rung is enabled, chunks are also ranked by vector similarity, with one embedding model pinned for the query. The rankings are fused with reciprocal rank fusion (k = 60), the best chunks are taken up to the budget, and neighbouring chunks of one video are merged into one time range (at most 4 minutes).
4. Sources are numbered `1..k` in video order and time, each with `videoId`, `title`, `url` (from `timestampUrl`), `startSec`, `endSec` and the raw caption text.

The `Retriever` interface (`retrieve(question, scope, ctx)`, optional `needsQuery(scope)`) is the seam for another engine, such as the hybrid search of item 40. Pass it as `retriever`.

## Grounding rules

The system prompt tells the model to use only the numbered sources, to end every factual sentence with its `[n]`, to say plainly when the videos do not cover the question, and to answer in the language of the question. All source text sits in one untrusted block fenced with a random boundary (`fenceUntrusted`), and the prompt says never to follow instructions found inside it.

After generation, every `[n]` is checked. Numbers that match no source are removed from the text (also while streaming: an unfinished `[...` is held back until its `]` arrives) and listed in `unverified`. Each cited source becomes a `Citation` whose `startSec` is narrowed to the segment inside the source that shares the most words with the sentences citing it (numbers count double), with a short `quote` of that segment.

## Multi-turn

Earlier turns go in `history` (or `messages` for `/chat`). When retrieval has to choose chunks, a follow-up like "how much power does it make?" is first rewritten into a standalone query by one cheap call (free-first chain, at most 3 rungs, never wider than the model choice allows). The answer call then sees the history, with old `[n]` markers stripped because they referred to an earlier source list. When every chunk fits, the rewrite is skipped.

## Model choice

| `model` | Meaning |
|---|---|
| omitted | Auto: the server's policy (`VID2CONTEXT_POLICY`, free first by default) |
| `{ policy: 'free' \| 'quality' \| 'local-only' }` | that policy over the whole chain |
| `{ rung: 'llm/ovh/gpt-oss-120b' }` | start with that rung, then fall back along the chain |
| `{ rung, strict: true }` | that rung or an error |

Resolution is core's `resolveModelChoice`; generation is core's `chatStream`, which falls back to the next rung only before the first answer delta and shares the chain's cooldowns. Rungs whose window cannot hold the prompt are skipped and recorded as `too-large` attempts.

## The SSE stream

`POST /api/v1/chat` always streams; `POST /api/v1/ask` streams when `stream: true`. Events: `meta`, then `reasoning` (only when the model exposes it), then `delta` one or more times, then `done`, or `error` instead of `done`. A `: keep-alive` comment goes out every 15 seconds; a client disconnect aborts the upstream call. Request errors are answered before streaming with the standard error body. Shapes are in [contracts/http-api.md](../contracts/http-api.md#post-chat-and-post-ask-with-stream-true).

A real stream, replayed from `packages/ask/test/fixtures/chat-sse-designo.json` (recorded from OVH Llama 3.3 70B, keyless), with the middle deltas and most sources cut for length:

```
SSE_EXAMPLE
```

## MCP

`registerAskTools(server, { registry, ctx, storage? })` registers `ask` with `{ question, urls?, collection? }`. It returns the answer, then one line per cited source, `[n] Title @ m:ss <timestamp URL>`, with the supporting quote. Failures are tool results with `isError` and `{ error: { code, message, hint }, attempts }`.

## Limits

Questions up to 4000 characters, at most 40 earlier turns (40000 characters), at most 50 inputs per request.
