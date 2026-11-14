# Ask and chat

`@vid2context/ask` answers questions about one video, several videos or a collection. Every factual sentence of the answer cites a numbered source as `[n]`, and every source is a timestamp link to the moment of the video that supports it. It powers `POST /api/v1/ask`, `POST /api/v1/chat` (the chat page) and the MCP `ask` tool.

```ts
import { ask } from '@vid2context/ask';
const r = await ask(registry, {
  question: 'How much horsepower does the G55 AMG compressor engine make, and does it have any known issues?',
  inputs: ['https://www.youtube.com/watch?v=cCPsdFdlshc'],
  storage,
}, ctx);
```

The real result (replayed from `packages/ask/test/fixtures/gwagon-g55.json`, OVH Llama 3.3 70B, keyless):

```json
{
  "answer": "The G55 AMG compressor engine makes 491 horsepower [5]. One known issue with this engine is that it \"drinks a little oil\" as it ages, with the example given being a truck with 131,000 miles that drinks a quart and a half of oil between oil changes [5][6].",
  "citations": [
    {
      "n": 5,
      "videoId": "youtube:cCPsdFdlshc",
      "title": "Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!",
      "startSec": 285.039,
      "endSec": 291.24,
      "url": "https://www.youtube.com/watch?v=cCPsdFdlshc&t=285s",
      "quote": "supercharged just so so we know but this is 491 horsepower of"
    },
    {
      "n": 6,
      "videoId": "youtube:cCPsdFdlshc",
      "title": "Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!",
      "startSec": 306.8,
      "endSec": 310.84,
      "url": "https://www.youtube.com/watch?v=cCPsdFdlshc&t=306s",
      "quote": "this one's got 131,000 mil on it and it drinks a quart and a half between oil"
    }
  ],
  "unverified": [],
  "rung": "llm/ovh/Meta-Llama-3_3-70B-Instruct",
  "model": "Meta-Llama-3_3-70B-Instruct"
}
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

A real stream: `POST /api/v1/chat` with "Which years have the designo seats?" over the G-Wagon video, replayed from `packages/ask/test/fixtures/chat-sse-designo.json` (recorded 2026-11-14 from the keyless lanes). OVH Llama 3.3 timed out, so the chain fell back to OVH gpt-oss-120b, which streamed 405 `reasoning` events and 59 `delta` events. Reasoning, the middle deltas and all but two sources are cut here. gpt-oss wrote its native `【7†L0-L4】` markers; they arrive as `[7]`.

```
event: meta
data: {"rung":"llm/ovh/gpt-oss-120b","model":"gpt-oss-120b","contextTokens":131072,"promptTokens":5401,"sources":[{"n":7,"videoId":"youtube:cCPsdFdlshc","title":"Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!","url":"https://www.youtube.com/watch?v=cCPsdFdlshc&t=364s","startSec":364,"endSec":423.479},{"n":8,"videoId":"youtube:cCPsdFdlshc","title":"Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!","url":"https://www.youtube.com/watch?v=cCPsdFdlshc&t=423s","startSec":423.479,"endSec":484.24}]}

event: delta
data: {"text":"The"}

event: delta
data: {"text":" video says the"}

event: delta
data: {"text":" “"}

event: delta
data: {"text":"design"}

...

event: delta
data: {"text":"[7]"}

event: delta
data: {"text":"[13]"}

event: delta
data: {"text":"."}

event: done
data: {"text":"The video says the “designo” seats first appear on the 2012 G‑55 AMG and that the exact same seats are carried forward unchanged through the later models \u2013 they remain on every G‑Wagon from 2012 up through the 2018 model year (the 2013‑2018 interior generation)[7][13].","rung":"llm/ovh/gpt-oss-120b","model":"gpt-oss-120b","usage":{"inputTokens":5080,"outputTokens":579},"citations":[{"n":7,"videoId":"youtube:cCPsdFdlshc","title":"Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!","startSec":408.4,"endSec":414.56,"url":"https://www.youtube.com/watch?v=cCPsdFdlshc&t=408s","quote":"2012 with 128,000 mil these deso seats were carried through into 2018 that look"},{"n":13,"videoId":"youtube:cCPsdFdlshc","title":"Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!","startSec":751.68,"endSec":757.16,"url":"https://www.youtube.com/watch?v=cCPsdFdlshc&t=751s","quote":"designo seats as in the 2012 same color same little compartment"}],"unverified":[],"attempts":[{"id":"llm/ovh/Meta-Llama-3_3-70B-Instruct","stage":"llm","outcome":"error","reason":"timeout","detail":"ovh chat stream timed out","ms":6},{"id":"llm/ovh/gpt-oss-120b","stage":"llm","outcome":"ok","ms":38}]}
```

## MCP

`registerAskTools(server, { registry, ctx, storage? })` registers `ask` with `{ question, urls?, collection? }`. It returns the answer, then one line per cited source, `[n] Title @ m:ss <timestamp URL>`, with the supporting quote. Failures are tool results with `isError` and `{ error: { code, message, hint }, attempts }`.

## Limits

Questions up to 4000 characters, at most 40 earlier turns (40000 characters), at most 50 inputs per request.
