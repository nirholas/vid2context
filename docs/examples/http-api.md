# HTTP API examples

The HTTP API serves the same pipeline as the CLI and MCP server, on Node, Cloudflare Workers, Vercel, Cloud Run and anywhere else Hono runs. Start it from a checkout with:

```sh
npm run start:server     # http://127.0.0.1:8787/api/v1/health
```

It listens on loopback only unless you set `HOST`. Every route, parameter and error code is in the [HTTP API contract](../contracts/http-api.md), and the guide is [HTTP API](../guides/http-api.md).

## Without a server

The app is a standard fetch handler. `createApp` builds the same app the server runs, and `app.request()` sends it a `Request`, so you can call the API in tests, in a Worker, or behind your own server without opening a port. This example seeds the library with two recorded transcripts, so it runs offline.

<!-- example: examples/http/in-process.ts -->
```ts
/**
 * Call the vid2context HTTP API without starting a server: build the same
 * Hono app `npm run start:server` serves and send it standard Request
 * objects. Useful in tests, in a Worker or behind your own Node server.
 *
 *   npx tsx examples/http/in-process.ts
 *
 * Offline: the library storage is seeded with two real recorded
 * transcripts, so every request below is answered from it without fetching
 * anything. Unknown URLs would go through the normal pipeline.
 */
import { readFileSync } from 'node:fs';
import { MemoryStorage, type VideoContext } from '@vid2context/core';
import { createNodeContext, createRegistry } from '@vid2context/registry/node';
import { createApp } from '@vid2context/server';

const load = (file: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8'));

const storage = new MemoryStorage();
await storage.putContext(load('youtube-jNQXAC9IVRw.json'));
await storage.putContext(load('youtube-cCPsdFdlshc.json'));

const app = createApp({
  registry: createRegistry(),
  makeCtx: (req) => createNodeContext({ signal: req.signal }),
  storage: async () => storage,
  onAccessLog: () => {},
});

const zoo = encodeURIComponent('https://www.youtube.com/watch?v=jNQXAC9IVRw');
const gwagon = encodeURIComponent('https://www.youtube.com/watch?v=cCPsdFdlshc');
const out = (s: string) => process.stdout.write(s);

const health = await app.request('/api/v1/health');
out(`GET /api/v1/health -> ${health.status}\n`);

const transcript = await app.request(`/api/v1/transcript?url=${zoo}&format=text&timestamps=1`);
out(`\nGET /api/v1/transcript -> ${transcript.status} ${transcript.headers.get('content-type')}\n`);
out(await transcript.text());

const outline = (await (await app.request(`/api/v1/outline?url=${gwagon}`)).json()) as {
  metadata: { title: string };
  chapters: { title: string; startSec: number; tokens: number }[];
  totalTokens: number;
};
out(`\nGET /api/v1/outline -> "${outline.metadata.title}", ${outline.totalTokens} tokens\n`);
for (const c of outline.chapters) out(`  ${c.title}: ${c.tokens} tokens\n`);

const section = await app.request(`/api/v1/section?url=${gwagon}&from=4:35&to=4:50&timestamps=1`);
out(`\nGET /api/v1/section?from=4:35&to=4:50 -> ${section.status}\n`);
out(await section.text());

const library = (await (await app.request('/api/v1/library')).json()) as { items: { id: string; title: string }[] };
out(`\nGET /api/v1/library -> ${library.items.length} saved\n`);
for (const v of library.items.sort((a, b) => a.id.localeCompare(b.id))) out(`  ${v.id}  ${v.title}\n`);

const missing = await app.request('/api/v1/transcript');
out(`\nGET /api/v1/transcript (no url) -> ${missing.status}\n${JSON.stringify(await missing.json(), null, 2)}\n`);

await app.close();
```

Output:

<!-- output: examples/http/in-process.ts -->
```text
GET /api/v1/health -> 200

GET /api/v1/transcript -> 200 text/plain; charset=utf-8
[0:01] All right, so here we are, in front of the elephants
[0:05] the cool thing about these guys is that they have really...
[0:07] really really long trunks
[0:12] and that's cool
[0:14] (baaaaaaaaaaahhh!!)
[0:16] and that's pretty much all there is to say

GET /api/v1/outline -> "Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!", 4484 tokens
  0:00 to 5:00: 1199 tokens
  5:00 to 10:02: 1271 tokens
  10:02 to 15:01: 1289 tokens
  15:01 to 18:05: 725 tokens

GET /api/v1/section?from=4:35&to=4:50 -> 200
[4:33] of the 55 ran to 03 and 04 just two
[4:35] years the compressor motor that came out
[4:37] in 05 that's where things got exciting
[4:39] you had a 490 horsepower compressor
[4:41] motor which is a Supercharged motor so
[4:43] when you see compressor that means
[4:45] supercharged just so so we
[4:47] know but this is 491 horsepower of

GET /api/v1/library -> 2 saved
  youtube:cCPsdFdlshc  Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!
  youtube:jNQXAC9IVRw  Me at the zoo

GET /api/v1/transcript (no url) -> 400
{
  "error": {
    "code": "bad-request",
    "message": "Missing the url query parameter.",
    "hint": "Pass ?url=<video URL>."
  },
  "attempts": [],
  "recovery": [
    {
      "action": "fix-input",
      "title": "Change the request",
      "detail": "The hint above says which field to fix."
    }
  ]
}
```

Every error has the same body: a stable `code`, a `message` and a `hint` that says how to recover, plus the `attempts` that were made.

## With curl

The routes you will use most: a transcript, the outline of a long video, one section by time, a context pack, keyword search over the library, a cited answer, and an error.

<!-- example: examples/http/curl.sh -->
```bash
#!/usr/bin/env bash
# The HTTP API with curl: health, a transcript, the outline of a long video,
# one section by time, a context pack, keyword search over the library, a
# cited answer, and what an error looks like.
#
#   npm run start:server                     # in another terminal
#   bash examples/http/curl.sh [base-url]
#
# Live, no keys needed. Needs curl and jq. Default base URL:
# http://127.0.0.1:8787. With API keys set on the server
# (VID2CONTEXT_API_KEYS), export VID2CONTEXT_API_KEY and it is sent as a
# bearer token.
set -euo pipefail

base="${1:-${VID2CONTEXT_URL:-http://127.0.0.1:8787}}/api/v1"
auth=()
if [ -n "${VID2CONTEXT_API_KEY:-}" ]; then auth=(-H "Authorization: Bearer $VID2CONTEXT_API_KEY"); fi
get() { curl -sS --fail-with-body "${auth[@]}" "$@"; }

zoo='https://www.youtube.com/watch?v=jNQXAC9IVRw'
gwagon='https://www.youtube.com/watch?v=cCPsdFdlshc'

echo "== GET /health"
get "$base/health" | jq -c '{ok, version, runtime, formats: [.formats[].id]}'

echo "== GET /transcript (text with timestamps)"
get -G "$base/transcript" --data-urlencode "url=$zoo" -d format=text -d timestamps=1

echo "== GET /outline (sections with token counts: read this first for long videos)"
get -G "$base/outline" --data-urlencode "url=$gwagon" |
  jq -r '"\(.metadata.title): \(.totalTokens) tokens", (.chapters[] | "  \(.title)  \(.tokens) tokens")'

echo "== GET /section (only 4:35 to 4:45)"
get -G "$base/section" --data-urlencode "url=$gwagon" -d from=4:35 -d to=4:45 -d timestamps=1

echo "== POST /pack (one Markdown document for a model, sized to a budget)"
get -X POST "$base/pack" -H 'Content-Type: application/json' \
  -d "{\"inputs\": [\"$zoo\", \"$gwagon\"], \"maxTokens\": 3000}" | head -n 3

echo "== GET /search (keyword side only; both videos are in the library now)"
get -G "$base/search" --data-urlencode 'q="compressor motor"' -d mode=keyword -d limit=2 |
  jq -r '.hits[] | "\(.title[0:40]) [\(.startSec | floor)s] \(.url)"'

echo "== POST /ask (an answer with verified [n] citations)"
get -X POST "$base/ask" -H 'Content-Type: application/json' \
  -d "{\"question\": \"What animal is in the video and what is special about it?\", \"inputs\": [\"$zoo\"], \"maxTokens\": 300}" |
  jq -r '.answer, (.citations[] | "  [\(.n)] \(.startSec)s \(.url)"), "answered by \(.rung)"'

echo "== An error: stable code, message and a hint on how to recover"
curl -sS "${auth[@]}" "$base/transcript" | jq -c .error
```

Recorded run against a local server started with no keys:

```text
== GET /health
{"ok":true,"version":"0.1.0","runtime":"node","formats":["text","json","markdown","srt","vtt","pack"]}
== GET /transcript (text with timestamps)
[0:01] All right, so here we are, in front of the elephants
[0:05] the cool thing about these guys is that they have really...
[0:07] really really long trunks
[0:12] and that's cool
[0:14] (baaaaaaaaaaahhh!!)
[0:16] and that's pretty much all there is to say
== GET /outline (sections with token counts: read this first for long videos)
Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!: 4487 tokens
  G wagon buying guide  273 tokens
  G500 m113 engine overview  218 tokens
  G500 interior and features  531 tokens
  G55 AMG specs and history  388 tokens
  G55 interior and technology  645 tokens
  Best G-Wagon for your budget  331 tokens
  G550 technological leap  729 tokens
  2016-2018 G-Wagon updates  388 tokens
  Final recommendations  984 tokens
== GET /section (only 4:35 to 4:45)
[4:33] of the 55 ran to 03 and 04 just two
[4:35] years the compressor motor that came out
[4:37] in 05 that's where things got exciting
[4:39] you had a 490 horsepower compressor
[4:41] motor which is a Supercharged motor so
[4:43] when you see compressor that means
== POST /pack (one Markdown document for a model, sized to a budget)
# Video context pack

This document holds the transcripts and metadata of 2 videos (18:23 in total), prepared by vid2context for an AI model to read. Each transcript paragraph starts with the time it begins in the video, in brackets; linked times open the video at that moment.
== GET /search (keyword side only; both videos are in the library now)
Best & Worst G-Wagon Years: Reliability, [254s] https://www.youtube.com/watch?v=cCPsdFdlshc&t=254s
== POST /ask (an answer with verified [n] citations)
The video shows **elephants**, and the speaker notes that the special thing about them is that **they have really, really long trunks** [1].
  [1] 5.318s https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s
answered by llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free
== An error: stable code, message and a hint on how to recover
{"code":"bad-request","message":"Missing the url query parameter.","hint":"Pass ?url=<video URL>."}
```

The live outline uses YouTube's auto-generated chapters (key moments) for this video. The recorded transcript the offline examples read has no chapters, so its outline falls back to sections of about five minutes.

## A typed fetch client with streaming

Plain `fetch` with typed responses: read the outline, fetch the largest section by its title, then stream an answer from `POST /chat`. The stream is server-sent events: `meta` (the numbered sources and the rung), `delta` text as it is written, then `done` with the verified citations, or `error`.

<!-- example: examples/http/client.ts -->
```ts
/**
 * A small typed client for the vid2context HTTP API with plain fetch: read
 * the outline of a long video, fetch one section, then stream a cited
 * answer from POST /chat (server-sent events) as it is written.
 *
 *   npm run start:server                     # in another terminal
 *   npx tsx examples/http/client.ts [base-url]
 *
 * Live, no keys needed. Default base URL: http://127.0.0.1:8787. Set
 * VID2CONTEXT_API_KEY when the server requires API keys.
 */
export {}; // No imports are needed, so mark the file as a module for top-level await.

const base = `${process.argv[2] ?? process.env.VID2CONTEXT_URL ?? 'http://127.0.0.1:8787'}/api/v1`;
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (process.env.VID2CONTEXT_API_KEY) headers.Authorization = `Bearer ${process.env.VID2CONTEXT_API_KEY}`;

interface ApiError {
  error: { code: string; message: string; hint?: string };
}
interface Outline {
  metadata: { title: string; durationSec?: number };
  chapters: { title: string; startSec: number; tokens: number }[];
  totalTokens: number;
}
interface Citation {
  n: number;
  title: string;
  startSec: number;
  url?: string;
}

/** Every error body has a stable code and a hint; surface both. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json()) as ApiError;
    throw new Error(`${res.status} ${body.error.code}: ${body.error.message} (${body.error.hint ?? 'no hint'})`);
  }
  return res;
}

const url = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const out = (s: string) => process.stdout.write(s);

// 1. The outline costs a few hundred tokens and says where everything is.
const outline = (await (await call(`/outline?${q({ url })}`)).json()) as Outline;
out(`${outline.metadata.title}: ${outline.totalTokens} tokens in ${outline.chapters.length} sections\n`);
const biggest = outline.chapters.reduce((a, b) => (b.tokens > a.tokens ? b : a));
out(`Largest section: "${biggest.title}" (${biggest.tokens} tokens)\n\n`);

// 2. Read only that section, by its title.
const section = await (await call(`/section?${q({ url, chapter: biggest.title, timestamps: '1' })}`)).text();
out(`${section.split('\n').slice(0, 5).join('\n')}\n...\n\n`);

// 3. Stream an answer. Events: meta, reasoning*, delta+, then done or error.
const res = await call('/chat', {
  method: 'POST',
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'Which model years do they recommend, and why?' }],
    context: { inputs: [url] },
    maxTokens: 600,
  }),
});
if (!res.body) throw new Error('The server sent no stream.');

let buffer = '';
const decoder = new TextDecoder();
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let end = buffer.indexOf('\n\n');
  while (end !== -1) {
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    end = buffer.indexOf('\n\n');
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (!event || !data) continue; // keep-alive comments
    const payload = JSON.parse(data);
    if (event === 'meta') out(`[${payload.sources.length} excerpts, answering with ${payload.rung}]\n`);
    if (event === 'delta') out(payload.text);
    if (event === 'done') {
      out('\n\nCitations:\n');
      for (const c of payload.citations as Citation[])
        out(`  [${c.n}] ${c.title.slice(0, 40)} @ ${Math.floor(c.startSec)}s ${c.url ?? ''}\n`);
    }
    if (event === 'error') throw new Error(`${payload.code}: ${payload.message} (${payload.hint ?? 'no hint'})`);
  }
}
```

Recorded run against a local server started with no keys. The streamed answer is left out because its wording comes from the model, and so are the last five of its ten citations:

```text
Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!: 4487 tokens in 9 sections
Largest section: "Final recommendations" (984 tokens)

[14:02] one of these let's talk the 2013 to 15
[14:05] and then the 2016 to 2018 the 2013 to 15
[14:08] are those who are looking for the
[14:09] ultimate daily driver fully user
[14:13] experience in other words you can hop in
...

[18 excerpts, answering with llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free]

Citations:
  [2] Best & Worst G-Wagon Years: Reliability, @ 71s https://www.youtube.com/watch?v=cCPsdFdlshc&t=71s
  [9] Best & Worst G-Wagon Years: Reliability, @ 504s https://www.youtube.com/watch?v=cCPsdFdlshc&t=504s
  [5] Best & Worst G-Wagon Years: Reliability, @ 291s https://www.youtube.com/watch?v=cCPsdFdlshc&t=291s
  [6] Best & Worst G-Wagon Years: Reliability, @ 338s https://www.youtube.com/watch?v=cCPsdFdlshc&t=338s
  [10] Best & Worst G-Wagon Years: Reliability, @ 583s https://www.youtube.com/watch?v=cCPsdFdlshc&t=583s
```

Citations are listed in order of first use, so the numbers are not sorted.
