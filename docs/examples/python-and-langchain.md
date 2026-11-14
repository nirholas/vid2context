# Python, LangChain and LlamaIndex examples

These examples call the HTTP API, so start it first:

```sh
npm run start:server     # http://127.0.0.1:8787/api/v1/health
```

The pipeline stays TypeScript (it also runs on Workers and in the browser). The Python client and the loaders are thin layers over the API, with timestamp metadata on every document so answers can cite the moment they came from. All of these are live and need no keys.

## LangChain.js

`VideoContextLoader` from `@vid2context/langchain` loads one Document per chapter (or per segment, or per time window). Ids are stable (`<video id>#<chunking>-<index>`), so loading the same video again upserts in a vector store instead of duplicating.

<!-- example: examples/langchain/loader.ts -->
```ts
/**
 * Load videos as LangChain.js Documents, one per chapter, each carrying the
 * video id, title, start and end seconds and a timestamp link in metadata.
 * Feed them to any splitter, vector store or retriever.
 *
 *   npm run start:server                     # in another terminal
 *   npx tsx examples/langchain/loader.ts [base-url]
 *
 * Live, no keys needed. Uses @vid2context/langchain against the HTTP API
 * (default http://127.0.0.1:8787); @langchain/core is its peer dependency.
 */
import { VideoContextLoader } from '@vid2context/langchain';

const loader = new VideoContextLoader(
  ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=cCPsdFdlshc'],
  {
    baseUrl: process.argv[2] ?? process.env.VID2CONTEXT_URL,
    apiKey: process.env.VID2CONTEXT_API_KEY,
    chunking: 'chapters', // or 'segments', or 'window' with windowSec
    continueOnFailure: true,
  },
);

const docs = await loader.load();
process.stdout.write(`${docs.length} documents\n\n`);
for (const doc of docs.slice(0, 4)) {
  process.stdout.write(`${doc.id}\n  ${JSON.stringify(doc.metadata)}\n  "${doc.pageContent.slice(0, 90)}..."\n`);
}
```

Recorded run, no keys (first two documents):

```text
11 documents

youtube:jNQXAC9IVRw#chapters-0
  {"source":"https://www.youtube.com/watch?v=jNQXAC9IVRw","title":"Me at the zoo","channel":"jawed","video_id":"youtube:jNQXAC9IVRw","platform":"youtube","transcript_origin":"creator-captions","language":"en","published_at":"2005-04-23","start_sec":0,"end_sec":5,"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s","chunking":"chapters","chapter":"Intro","chapter_index":0}
  "All right, so here we are, in front of the elephants..."
youtube:jNQXAC9IVRw#chapters-1
  {"source":"https://www.youtube.com/watch?v=jNQXAC9IVRw","title":"Me at the zoo","channel":"jawed","video_id":"youtube:jNQXAC9IVRw","platform":"youtube","transcript_origin":"creator-captions","language":"en","published_at":"2005-04-23","start_sec":5,"end_sec":17,"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s","chunking":"chapters","chapter":"The cool thing","chapter_index":1}
  "the cool thing about these guys is that they have really... really really long trunks and ..."
```

## The Python client

Install it from the repo root with `pip install ./clients/python` (its only dependency is `httpx`). The client reads the outline, fetches a section by time, and raises `Vid2ContextError` with the server's `code`, HTTP status and `hint`. Routes it does not wrap yet, such as `/ask`, are one `httpx` call away. The full method list is in [clients/python/README.md](../../clients/python/README.md).

<!-- example: examples/python/client_basics.py -->
```python
"""The vid2context Python client: outline first, then one section, then a
cited answer, and what an error looks like.

    npm run start:server                          # in another terminal
    pip install ./clients/python                  # from the repo root
    python examples/python/client_basics.py [base-url]

Live, no keys needed. Default base URL: VID2CONTEXT_API_URL, else
http://127.0.0.1:8787. POST /ask is not wrapped by the client yet, so it is
called with httpx (the client's only dependency) against the same server.
"""

from __future__ import annotations

import sys

import httpx

from vid2context import Client, Vid2ContextError

base_url = sys.argv[1] if len(sys.argv) > 1 else None
url = "https://www.youtube.com/watch?v=cCPsdFdlshc"

with Client(base_url=base_url) as v2c:
    health = v2c.health()
    print(f"server {health.version} on {health.runtime}, formats: {', '.join(f.id for f in health.formats)}")

    # 1. The outline is cheap: sections with token counts, so you read only what you need.
    outline = v2c.outline(url)
    print(f"\n{outline.metadata.title}: {outline.total_tokens} tokens")
    for ch in outline.chapters:
        print(f"  {ch.start_sec:7.1f}s  {ch.tokens:4d} tokens  {ch.title}")

    # 2. One section by time ("m:ss" strings or seconds), end exclusive.
    print("\n4:35 to 4:45:")
    print(v2c.section(url, start="4:35", end="4:45", timestamps=True))

    # 3. Errors carry a stable code, the HTTP status and a hint on how to recover.
    try:
        v2c.context("https://example.com/not-a-video")
    except Vid2ContextError as e:
        print(f"error: {e.code} (HTTP {e.status}): {e.hint}")

# 4. A cited answer from POST /ask.
api = (base_url or "http://127.0.0.1:8787").rstrip("/")
reply = httpx.post(
    f"{api}/api/v1/ask",
    json={"question": "Which engine do they call the most reliable?", "inputs": [url], "maxTokens": 400},
    timeout=300,
)
reply.raise_for_status()
answer = reply.json()
print(f"\n{answer['answer']}")
for c in answer["citations"]:
    print(f"  [{c['n']}] {c['startSec']:.0f}s {c.get('url', '')}")
print(f"answered by {answer['rung']}")
```

Recorded run, no keys:

```text
server 0.1.0 on node, formats: text, json, markdown, srt, vtt, pack

Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!: 4487 tokens
      0.0s   273 tokens  G wagon buying guide
     65.3s   218 tokens  G500 m113 engine overview
    124.2s   531 tokens  G500 interior and features
    252.5s   388 tokens  G55 AMG specs and history
    350.4s   645 tokens  G55 interior and technology
    505.0s   331 tokens  Best G-Wagon for your budget
    579.8s   729 tokens  G550 technological leap
    747.2s   388 tokens  2016-2018 G-Wagon updates
    841.1s   984 tokens  Final recommendations

4:35 to 4:45:
[4:33] of the 55 ran to 03 and 04 just two
[4:35] years the compressor motor that came out
[4:37] in 05 that's where things got exciting
[4:39] you had a 490 horsepower compressor
[4:41] motor which is a Supercharged motor so
[4:43] when you see compressor that means

error: not-found (HTTP 404): Check the URL; the video may have been removed or never existed.

The M113 V8 is described as "probably arguably one of their most reliable V8s out there" and "as reliable as it gets" [2].
  [2] 71s https://www.youtube.com/watch?v=cCPsdFdlshc&t=71s
answered by llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free
```

## LangChain (Python)

`pip install "./clients/python[langchain]"`. The same documents and metadata as the LangChain.js loader; `alazy_load()` and `aload()` are there for async code.

<!-- example: examples/python/langchain_loader.py -->
```python
"""Load videos as LangChain Documents, one per chapter, with the video id,
title, start and end seconds and a timestamp link in metadata. Documents
have stable ids, so loading the same video again upserts in a vector store.

    npm run start:server                          # in another terminal
    pip install "./clients/python[langchain]"     # from the repo root
    python examples/python/langchain_loader.py [base-url]

Live, no keys needed.
"""

from __future__ import annotations

import sys

from vid2context.langchain import VideoContextLoader

loader = VideoContextLoader(
    ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "https://www.youtube.com/watch?v=cCPsdFdlshc"],
    chunking="chapters",  # or "segments", or "window" with window_sec=90
    base_url=sys.argv[1] if len(sys.argv) > 1 else None,
    continue_on_failure=True,
)

docs = loader.load()
print(f"{len(docs)} documents")
for doc in docs[:3]:
    m = doc.metadata
    print(f"\n{doc.id}")
    print(f"  {m['title'][:40]} [{m['start_sec']}s to {m['end_sec']}s] {m.get('chapter', '')}")
    print(f"  {m['url']}")
    print(f"  {doc.page_content[:90]}...")
```

Recorded run, no keys:

```text
11 documents

youtube:jNQXAC9IVRw#chapters-0
  Me at the zoo [0.0s to 5.0s] Intro
  https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s
  All right, so here we are, in front of the elephants...

youtube:jNQXAC9IVRw#chapters-1
  Me at the zoo [5.0s to 17.0s] The cool thing
  https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s
  the cool thing about these guys is that they have really... really really long trunks and ...

youtube:cCPsdFdlshc#chapters-0
  Best & Worst G-Wagon Years: Reliability, [0.0s to 65.28s] G wagon buying guide
  https://www.youtube.com/watch?v=cCPsdFdlshc&t=0s
  so you're going to buy G wagon which year is best for you well in this video we're going t...
```

## LlamaIndex

`pip install "./clients/python[llama-index]"`. Windows of about 90 seconds suit retrieval over long talks. The citation fields stay on each node for your answer to use, but out of the embedded text, so they do not skew similarity.

<!-- example: examples/python/llama_index_reader.py -->
```python
"""Read videos into LlamaIndex Documents in windows of about 90 seconds,
ready for a VectorStoreIndex. The citation fields (url, video_id) stay on
each node but out of the embedded text.

    npm run start:server                          # in another terminal
    pip install "./clients/python[llama-index]"   # from the repo root
    python examples/python/llama_index_reader.py [base-url]

Live, no keys needed.
"""

from __future__ import annotations

import sys

from vid2context.llama_index import VideoContextReader

reader = VideoContextReader(
    chunking="window",
    window_sec=90,
    base_url=sys.argv[1] if len(sys.argv) > 1 else None,
)
docs = reader.load_data(["https://www.youtube.com/watch?v=cCPsdFdlshc"])

print(f"{len(docs)} documents")
for doc in docs[:3]:
    m = doc.metadata
    print(f"  window {m['window_index']}: {m['start_sec']}s to {m['end_sec']}s  {m['url']}")
print(f"kept out of embeddings: {', '.join(docs[0].excluded_embed_metadata_keys)}")
```

Recorded run, no keys:

```text
12 documents
  window 0: 0.64s to 91.24s  https://www.youtube.com/watch?v=cCPsdFdlshc&t=0s
  window 1: 91.24s to 182.72s  https://www.youtube.com/watch?v=cCPsdFdlshc&t=91s
  window 2: 182.72s to 273.0s  https://www.youtube.com/watch?v=cCPsdFdlshc&t=182s
kept out of embeddings: source, url, video_id, platform, transcript_origin, chunking, window_index
```
