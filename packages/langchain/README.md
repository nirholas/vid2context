# @vid2context/langchain

A LangChain.js document loader for [vid2context](https://github.com/nirholas/vid2context): it loads videos as `Document`s with timestamp metadata by calling the vid2context HTTP API with `fetch`. The Python twin is in [clients/python](../../clients/python), with the same chunking and metadata.

It talks to a vid2context server you run (default `http://127.0.0.1:8787`), so everything stays free and local unless you point it elsewhere.

## Install from the repo

```sh
npm install                   # at the repo root; links this workspace
npm run start:server          # http://127.0.0.1:8787/api/v1/health
```

In another workspace of this repo, add `"@vid2context/langchain": "*"` and `@langchain/core` (a peer dependency, `^0.3.0 || ^1.0.0`). The package exports TypeScript source, like every package here, so run it with `tsx` or a bundler until release tooling (roadmap item 38) builds it for npm.

## Quick start

```ts
import { VideoContextLoader } from '@vid2context/langchain';

const docs = await new VideoContextLoader('https://youtu.be/jNQXAC9IVRw').load();
console.log(docs[0].pageContent, docs[0].metadata);

// Many videos, streamed one video at a time:
const loader = new VideoContextLoader(['https://youtu.be/jNQXAC9IVRw', 'https://www.youtube.com/watch?v=cCPsdFdlshc'], {
  chunking: 'window',
  windowSec: 90,
});
for await (const doc of loader.lazyLoad()) console.log(doc.id, doc.metadata.url);
```

## Loader options

`new VideoContextLoader(urls: string | string[], options?)`

| Option | Default | Meaning |
|---|---|---|
| `chunking` | `'chapters'` | `chapters`: one document per chapter; a video without chapters is split into windows instead, and its documents say `chunking: 'window'`, `chunking_requested: 'chapters'`. `segments`: one per caption line. `window`: about `windowSec` each; a window starts at its first segment and takes each segment that starts before `start + windowSec`, never splitting one |
| `windowSec` | `60` | Window length in seconds |
| `mode` | server default (`auto`) | `auto`, `captions`, `stt` or `video` |
| `lang` | | Preferred transcript language, BCP-47 |
| `baseUrl` | `http://127.0.0.1:8787` | Server URL; a trailing `/api/v1` is accepted. The loader never reads `process.env`; pass `process.env.VID2CONTEXT_API_URL` yourself if you use it |
| `apiKey` | | Sent as `Authorization: Bearer <key>` (servers with `VID2CONTEXT_API_KEYS`) |
| `fetch` | global `fetch` | Any fetch implementation |
| `signal` | | Abort the requests |
| `continueOnFailure` | `false` | Skip videos that fail instead of throwing |
| `onSkip` | one stderr line | `(url, error) => void`, called for each skipped video |

Failures throw `Vid2ContextApiError` (a core `Vid2ContextError`) with `code`, `message`, `hint`, `status` and `attempts`, parsed from the server's error body; `serverCode` keeps the server's code verbatim (`internal` maps to `code: 'upstream'`). An unreachable server gives `upstream` with a hint to start it.

Document text is the raw transcript text of the chunk with whitespace collapsed, never a summary. Every document has a stable `id`, `<video_id>#<chunking>-<index>`, so loading a video again lets a vector store upsert.

## Metadata fields

| Field | Example |
|---|---|
| `source` | `https://www.youtube.com/watch?v=jNQXAC9IVRw` |
| `title` | `Me at the zoo` |
| `channel` | `jawed` |
| `video_id` | `youtube:jNQXAC9IVRw` |
| `platform` | `youtube` |
| `start_sec`, `end_sec` | `5`, `17` |
| `url` | `https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s` (opens the video at `start_sec`) |
| `transcript_origin` | `creator-captions`, `auto-captions`, `native-transcript`, `stt` or `video-model` |
| `language` | `en` |
| `published_at` | ISO 8601, when known |
| `chunking` | `chapters`, `segments` or `window` |
| `chapter`, `chapter_index` | chapters mode |
| `segment_index` / `window_index` | segments and window modes |

Keys are snake_case to match the Python loader, so documents from either client can share one index. Unknown fields are left out rather than set to `undefined` or `null`, which several vector stores reject.

## Tests

```sh
npx vitest run packages/langchain
```

The tests replay real responses recorded from a running vid2context server (`clients/python/tests/fixtures/`, shared with the Python client) through `replayFetch`.
