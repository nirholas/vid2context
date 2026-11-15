# Library examples

The TypeScript API from `@vid2context/core` and its sibling packages. Everything an agent surface does (CLI, MCP, HTTP) is built from these calls, so you can do the same in your own code. Run any of them from the repo root with `npx tsx <file>`.

The first six are offline: they read real transcripts recorded from YouTube and make no network calls. The output under each one is what it prints. The last four are live and need no keys.

## Render every format

One `VideoContext` renders as plain text, timestamped text, SRT, WebVTT, Markdown with timestamp links, or a context pack written for an AI model. `formatters` lists them at runtime, so a format added to core shows up here too.

<!-- example: examples/library/render-formats.ts -->
```ts
/**
 * Render one transcript in every output format: plain text, timestamped
 * text, Markdown, SRT, WebVTT and the context pack written for AI models.
 *
 *   npx tsx examples/library/render-formats.ts
 *
 * Offline: reads a real VideoContext recorded from YouTube ("Me at the zoo").
 */
import { readFileSync } from 'node:fs';
import { formatters, render, type VideoContext } from '@vid2context/core';

const context: VideoContext = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contexts/youtube-jNQXAC9IVRw.json', import.meta.url), 'utf8'),
);

const out = (s: string) => process.stdout.write(s);

out(`Formats: ${Object.keys(formatters).join(', ')}\n\n`);

out('--- text\n');
out(render(context, 'text'));

out('\n--- text with timestamps\n');
out(render(context, 'text', { timestamps: true }));

out('\n--- srt (first two cues)\n');
out(`${render(context, 'srt').split('\n\n').slice(0, 2).join('\n\n')}\n`);

out('\n--- vtt (header, note and first cue)\n');
out(`${render(context, 'vtt').split('\n\n').slice(0, 3).join('\n\n')}\n`);

out('\n--- markdown\n');
out(render(context, 'markdown'));

out('\n--- pack (first 12 lines)\n');
out(`${render(context, 'pack', { maxTokens: 2000 }).split('\n').slice(0, 12).join('\n')}\n`);
```

Output:

<!-- output: examples/library/render-formats.ts -->
```text
Formats: text, json, markdown, srt, vtt, pack

--- text
All right, so here we are, in front of the elephants the cool thing about these guys is that they have really... really really long trunks and that's cool (baaaaaaaaaaahhh!!) and that's pretty much all there is to say

--- text with timestamps
[0:01] All right, so here we are, in front of the elephants
[0:05] the cool thing about these guys is that they have really...
[0:07] really really long trunks
[0:12] and that's cool
[0:14] (baaaaaaaaaaahhh!!)
[0:16] and that's pretty much all there is to say

--- srt (first two cues)
1
00:00:01,200 --> 00:00:03,360
All right, so here we are,
in front of the elephants

2
00:00:05,318 --> 00:00:07,974
the cool thing about these guys
is that they have really...

--- vtt (header, note and first cue)
WEBVTT

NOTE
Me at the zoo
Source: https://www.youtube.com/watch?v=jNQXAC9IVRw
Transcript: creator captions from youtube-captions

00:00:01.200 --> 00:00:03.360
All right, so here we are,
in front of the elephants

--- markdown
# Me at the zoo

- Channel: [jawed](https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A)
- Duration: 0:19
- Source: https://www.youtube.com/watch?v=jNQXAC9IVRw
- Language: en
- Transcript: creator captions from youtube-captions

## Description

> Microplastics are accumulating in human brains at an alarming rate
> https://www.youtube.com/watch?v=0PT5c1z3LL8
>
> “Nanoplastics and Human Health” with Matthew J Campen, PhD, MSPH
> https://www.youtube.com/watch?v=RRBN_4L09Mg
>
> 00:00 Intro
> 00:05 The cool thing
> 00:17 End

## Intro (0:00)

[0:01](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s) All right, so here we are, in front of the elephants

## The cool thing (0:05)

[0:05](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s) the cool thing about these guys is that they have really... really really long trunks and that's cool (baaaaaaaaaaahhh!!) and that's pretty much all there is to say

--- pack (first 12 lines)
# Video context pack

This document holds the transcripts and metadata of one video (0:19 in total), prepared by vid2context for an AI model to read. Each transcript paragraph starts with the time it begins in the video, in brackets; linked times open the video at that moment.

Citation rule: when you use something from a video, cite it as [Title @ m:ss](link), using the time and link of the paragraph you drew on (or [Title @ m:ss] when the video has no link).

## Me at the zoo

- Channel: [jawed](https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A)
- Duration: 0:19
- Source: https://www.youtube.com/watch?v=jNQXAC9IVRw
- Language: en
```

## Read a long video, outline first

Speech is about 12k tokens per hour. Instead of loading a whole transcript, read the outline (a few hundred tokens), then pull the one section you need. Videos with chapters list them; videos without get sections of about five minutes, cut at sentence ends or pauses. `getSection` slices the raw transcript and never rewrites it.

<!-- example: examples/library/outline-and-sections.ts -->
```ts
/**
 * Read a long video the way an agent should: look at the outline (sections
 * with token counts) first, then pull only the section you need, by chapter
 * or by time range.
 *
 *   npx tsx examples/library/outline-and-sections.ts
 *
 * Offline: reads a real 18-minute YouTube transcript (auto-captions, no
 * chapters, so the outline falls back to sections of about five minutes).
 */
import { readFileSync } from 'node:fs';
import {
  estimateTokens,
  formatTimestamp,
  getSection,
  parseTimeArg,
  render,
  transcriptOutline,
  type VideoContext,
} from '@vid2context/core';

const context: VideoContext = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8'),
);

const out = (s: string) => process.stdout.write(s);

// 1. The outline: cheap to read, tells you where everything is and what it costs.
const outline = transcriptOutline(context);
out(`${outline.title}\n${formatTimestamp(outline.durationSec)} long, about ${outline.totalTokens} tokens\n\n`);
for (const s of outline.sections) {
  out(
    `  #${s.index}  ${formatTimestamp(s.startSec).padStart(5)}  ${String(s.tokens).padStart(5)} tokens  ${s.title} (${s.source})\n`,
  );
}

// 2. One section by its outline index. The raw transcript is sliced, never rewritten.
const third = getSection(context, { chapter: 2 });
out(`\nSection #2: ${third.transcript.segments.length} segments, about ${estimateTokens(render(third, 'text'))} tokens\n`);
out(`${render(third, 'text', { timestamps: true }).split('\n').slice(0, 4).join('\n')}\n`);

// 3. A time range, with times written the way people type them.
const range = getSection(context, { fromSec: parseTimeArg('12:30'), toSec: parseTimeArg('13:00') });
out('\n12:30 to 13:00\n');
out(render(range, 'text', { timestamps: true }));
```

Output:

<!-- output: examples/library/outline-and-sections.ts -->
```text
Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!
18:05 long, about 4484 tokens

  #0   0:00   1199 tokens  0:00 to 5:00 (time)
  #1   5:00   1271 tokens  5:00 to 10:02 (time)
  #2  10:02   1289 tokens  10:02 to 15:01 (time)
  #3  15:01    725 tokens  15:01 to 18:05 (time)

Section #2: 150 segments, about 1290 tokens
[10:02] is the year range for this generation
[10:03] yes yep this generation you can still
[10:05] get this motor in the prior generation
[10:07] through 11 and 12 but for this interior

12:30 to 13:00
[12:27] with wireless Android auto the
[12:30] difference here again look at this same
[12:31] designo seats as in the
[12:33] 2012 same color same little compartment
[12:37] down here same everything again minimal
[12:40] differences if you've watched this
[12:42] Channel and if you haven't welcome I did
[12:44] another video showing the difference
[12:45] between this rig and then we have
[12:47] another 2018 now you'll notice in 2017
[12:50] and 2018 there's a couple small
[12:51] differences dash cluster changes they
[12:53] made them a little bit more modern the
[12:54] other thing you'll notice is in a 2017
[12:56] and 18 excuse me 16 to 18 you do get a
[12:59] manual mode as opposed to just uh
```

A time range keeps every caption that overlaps it, which is why the 12:30 range starts with a caption at 12:27.

## Chunk for retrieval and fit a token budget

`chunkTranscript` cuts on segment boundaries only, so every chunk maps back to exact times, and the overlap is whole segments. `fitToBudget` decides how much of several videos fits a context window and lists what it left out, so you can tell the model what is missing.

<!-- example: examples/library/chunk-for-rag.ts -->
```ts
/**
 * Prepare transcripts for retrieval or a fixed context window: cut a
 * transcript into token-bounded chunks with overlap, then plan how much of
 * several videos fits in one budget.
 *
 *   npx tsx examples/library/chunk-for-rag.ts
 *
 * Offline: reads two real YouTube transcripts recorded by vid2context.
 */
import { readFileSync } from 'node:fs';
import { chunkTranscript, fitToBudget, formatTimestamp, type VideoContext } from '@vid2context/core';

const load = (file: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8'));

const gwagon = load('youtube-cCPsdFdlshc.json');
const zoo = load('youtube-jNQXAC9IVRw.json');
const out = (s: string) => process.stdout.write(s);

// 1. Chunks of at most 800 tokens, each repeating up to 80 tokens of the one before.
//    Segments are never split, so every chunk maps back to exact transcript times.
const chunks = chunkTranscript(gwagon, { maxTokens: 800, overlapTokens: 80 });
out(`${chunks.length} chunks from "${gwagon.metadata.title}"\n`);
for (const c of chunks) {
  const range = `${formatTimestamp(c.startSec)}-${formatTimestamp(c.endSec)}`;
  out(`  #${c.index}  ${range.padEnd(11)}  ${String(c.tokens).padStart(3)} tokens  overlap ${c.overlapSegments} segments\n`);
}
const first = chunks[0];
if (first) out(`\nChunk #0 starts: "${first.text.slice(0, 80)}..."\n`);

// 2. By chapter: the zoo video has three description chapters, so each chunk stays inside one.
out(`\nBy chapter (${zoo.metadata.title}):\n`);
for (const c of chunkTranscript(zoo, { maxTokens: 200, by: 'chapters' })) {
  out(`  ${c.chapterTitle ?? '(none)'}: ${c.text}\n`);
}

// 3. A 3,000-token budget across both videos: whole videos when they fit,
//    otherwise leading sections, and a list of exactly what was left out.
const plan = fitToBudget([zoo, gwagon], 3000, { perVideoOverhead: 60 });
out(`\nBudget plan: ${plan.totalTokens} of 3000 tokens used\n`);
for (const item of plan.items) {
  const kept = item.whole
    ? 'whole transcript'
    : (item.sections ?? []).map((s) => `${formatTimestamp(s.startSec)}-${formatTimestamp(s.endSec)}`).join(', ') || 'nothing';
  out(`  ${item.videoId}: ${kept}\n`);
}
for (const o of plan.omitted) {
  out(`  left out: ${o.videoId} ${formatTimestamp(o.startSec)}-${formatTimestamp(o.endSec)} (${o.tokens} tokens)\n`);
}
```

Output:

<!-- output: examples/library/chunk-for-rag.ts -->
```text
7 chunks from "Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!"
  #0  0:00-2:01    483 tokens  overlap 0 segments
  #1  1:40-4:51    756 tokens  overlap 9 segments
  #2  4:33-7:36    751 tokens  overlap 8 segments
  #3  7:23-10:14   756 tokens  overlap 8 segments
  #4  9:58-12:53   750 tokens  overlap 8 segments
  #5  12:33-15:36  755 tokens  overlap 9 segments
  #6  15:21-18:05  667 tokens  overlap 8 segments

Chunk #0 starts: "so you're going to buy G wagon which year is best for you well in this video we'..."

By chapter (Me at the zoo):
  Intro: All right, so here we are, in front of the elephants
  The cool thing: the cool thing about these guys is that they have really... really really long trunks and that's cool (baaaaaaaaaaahhh!!) and that's pretty much all there is to say

Budget plan: 2998 of 3000 tokens used
  youtube:jNQXAC9IVRw: whole transcript
  youtube:cCPsdFdlshc: 0:00-5:00, 5:00-10:02, 10:02-11:21
  left out: youtube:cCPsdFdlshc 11:21-18:05 (1670 tokens)
```

For search indexes, `@vid2context/search` has its own time-based `chunkTranscript` (30 to 60 second windows); see [Search](../guides/search.md).

## Clean up auto-captions

Auto-captions have no punctuation and repeat themselves as they roll. `cleanTranscript` removes rolling duplicates, restores sentence starts and ends with rules, optionally removes fillers, and reports every change. It returns a new transcript; keep the raw one.

<!-- example: examples/library/clean-captions.ts -->
```ts
/**
 * Turn unpunctuated auto-captions into readable sentences with the rule-based
 * cleanup (no model, no network), and read the report of what changed.
 *
 *   npx tsx examples/library/clean-captions.ts
 *
 * Offline: reads a real YouTube auto-caption transcript. The cleaned
 * transcript is a new object; the raw one is kept unchanged.
 */
import { readFileSync } from 'node:fs';
import { cleanTranscript, formatTimestamp, segmentsToText, type VideoContext } from '@vid2context/core';

const context: VideoContext = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8'),
);
const raw = context.transcript;
const out = (s: string) => process.stdout.write(s);

const { transcript: clean, report } = await cleanTranscript(raw, { sentences: true, fillers: true });

out(`Steps: ${report.steps.join(', ')}\n`);
out(`Segments: ${raw.segments.length} raw, ${clean.segments.length} clean `);
out(`(${report.merged} merged, ${report.removed} removed, ${report.rewritten} rewritten)\n`);

// Show the captions around the first sentence end the cleanup restored.
const at = Math.max(
  0,
  clean.segments.findIndex((s, i) => /[.?!]$/.test(s.text) && s.text !== raw.segments[i]?.text),
);
const window = (segments: typeof raw.segments) => segmentsToText(segments.slice(Math.max(0, at - 3), at + 4));
out(`\nRaw, around ${formatTimestamp(clean.segments[at]?.startSec ?? 0)}:\n${window(raw.segments)}\n`);
out(`\nClean:\n${window(clean.segments)}\n`);

out('\nFirst three changes:\n');
for (const ex of report.examples.slice(0, 3)) {
  out(`  [${formatTimestamp(ex.atSec)}] ${ex.rule}: "${ex.before}" -> "${ex.after}"\n`);
}
```

Output:

<!-- output: examples/library/clean-captions.ts -->
```text
Steps: normalize, dedupe-rolling, restore-sentences, remove-fillers
Segments: 521 raw, 521 clean (0 merged, 0 removed, 38 rewritten)

Raw, around 0:36:
produce not only these videos but also the ultimate build and buyer guide for the G wagon so if you're in the market click the link in the description right now Joe thanks for being here man all right let's get into it let's rock and roll let's introduce each one of these

Clean:
produce not only these videos but also the ultimate build and buyer guide for the G wagon so if you're in the market click the link in the description right. Now Joe thanks for being here man all right let's get into it let's rock and roll let's introduce each one of these

First three changes:
  [5:38] rolling-duplicate: "with the m113 yep up until 20 through" -> "m113 yep up until 20 through"
  [0:00] sentence: "so you're going to buy G wagon which" -> "So you're going to buy G wagon which"
  [0:36] sentence: "click the link in the description right" -> "click the link in the description right."
```

The rules guess, and this output shows one wrong guess ("right. Now" should be "right now."). For better punctuation, pass `llm: { registry, ctx }` to add a model pass. Each chunk the model returns is accepted only when its words match the input word for word, so the model can punctuate but cannot change what was said. See [Cleanup](../cleanup.md).

## Search across videos

Index transcripts once, then search with plain words, `"exact phrases"` and `-excluded` words. Each hit comes with its time range, a timestamp link and a snippet with the matched words in bold. This example uses a registry with no providers, so the engine has no embedding model and runs BM25 in memory. With `createRegistry()` it adds vector search through the free-first embedding chain and fuses both rankings.

<!-- example: examples/library/search-transcripts.ts -->
```ts
/**
 * Find where a topic comes up across several videos: index transcripts, then
 * search with plain words, an exact "phrase" and an -excluded word. Every hit
 * comes back with a time range, a timestamp link and a highlighted snippet.
 *
 *   npx tsx examples/library/search-transcripts.ts
 *
 * Offline: an engine built on a registry with no providers has no embedding
 * model, so it runs BM25 keyword search in memory and never calls the
 * network. Pass createRegistry() from '@vid2context/registry/node' instead to
 * add vector search with the free-first embedding chain.
 */
import { readFileSync } from 'node:fs';
import { createContext, formatTimestamp, Registry, type VideoContext } from '@vid2context/core';
import { createSearchEngine } from '@vid2context/search';

const load = (file: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8'));

const ctx = createContext({ runtime: 'node' });
const engine = createSearchEngine({ registry: new Registry([], 'node'), ctx });

for (const context of [load('youtube-cCPsdFdlshc.json'), load('youtube-jNQXAC9IVRw.json')]) {
  const r = await engine.index(context);
  process.stdout.write(`indexed ${r.videoId}: ${r.chunks} chunks, vectors ${r.vector}\n`);
}

for (const query of ['timing chain', '"supercharged"', 'engine -oil', 'elephants trunks']) {
  const { hits, meta } = await engine.search({ query, limit: 2 });
  process.stdout.write(`\n${query}  (${meta.keyword.backend}, vectors ${meta.vector}, ${hits.length} hits)\n`);
  for (const h of hits) {
    process.stdout.write(`  ${h.title.slice(0, 40)} [${formatTimestamp(h.startSec)}-${formatTimestamp(h.endSec)}]\n`);
    process.stdout.write(`    ${h.url}\n    ${h.snippet}\n`);
  }
}
```

Output:

<!-- output: examples/library/search-transcripts.ts -->
```text
indexed youtube:cCPsdFdlshc: 33 chunks, vectors disabled
indexed youtube:jNQXAC9IVRw: 2 chunks, vectors disabled

timing chain  (bm25, vectors disabled, 1 hits)
  Best & Worst G-Wagon Years: Reliability, [0:55-2:01]
    https://www.youtube.com/watch?v=cCPsdFdlshc&t=55s
    ...is probably arguably one of their most reliable V8s out there some call it the Land Cruiser killer some yeah it is known as a Land Cruiser killer I really like this motor it's all aluminum it's super light and it is as reliable as as it gets now some of the key things it's a single overhead cam motor it's **timing** **Chains**...

"supercharged"  (bm25, vectors disabled, 1 hits)
  Best & Worst G-Wagon Years: Reliability, [4:35-5:13]
    https://www.youtube.com/watch?v=cCPsdFdlshc&t=275s
    years the compressor motor that came out in 05 that's where things got exciting you had a 490 horsepower compressor motor which is a **Supercharged** motor so when you see compressor that means **supercharged** just so so we know but this is 491 horsepower of German ponies got to love it this sounds amazing and it uses a 5...

engine -oil  (bm25, vectors disabled, 2 hits)
  Best & Worst G-Wagon Years: Reliability, [0:00-2:01]
    https://www.youtube.com/watch?v=cCPsdFdlshc&t=0s
    ...three trucks we're going to hit the year range the **engine** options and give you an interior tour it's roag and roll cool we have three trucks here starting with our first one we have a 2000 G500 the second one is a to uh 2012 G55 AMG the third one is a 2015 G550 we're going to walk through and look at some of the **engine**...
  Best & Worst G-Wagon Years: Reliability, [16:03-16:41]
    https://www.youtube.com/watch?v=cCPsdFdlshc&t=963s
    ...reliability power Tech that just works really really well yeah and I will say for those that do want to go Wheeling I find that this in four low compared to the uh 4 L biturbo in four low this is less Twitchy on the throttle uh yes yes agre and and you don't have there's I really prefer the naturally aspirated **engine**...

elephants trunks  (bm25, vectors disabled, 2 hits)
  Me at the zoo [0:01-0:03]
    https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s
    All right, so here we are, in front of the **elephants**
  Me at the zoo [0:05-0:18]
    https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s
    the cool thing about these guys is that they have really... really really long **trunks** and that's cool (baaaaaaaaaaahhh!!) and that's pretty much all there is to say
```

"timing chain" finds the right minute even though the snippet starts before the words, because hits are merged time ranges. See [Search](../guides/search.md) for the query syntax and how ranking works.

## Build a context bundle (.zip)

A bundle holds every format per video, one `context.md` sized to a token budget, an `index.md`, `llms.txt`, a README that tells an agent how to read it, and a manifest with SHA-256 hashes. Upload it to a ChatGPT or Claude Project, or hand it to an agent. The same inputs and `createdAt` give a byte-identical zip.

<!-- example: examples/library/context-bundle.ts -->
```ts
/**
 * Package videos for an agent or a ChatGPT/Claude Project: a .zip with every
 * format per video, one context.md written for a model, a manifest with
 * SHA-256 hashes and a README that tells an agent how to read it.
 *
 *   npx tsx examples/library/context-bundle.ts [out.zip]
 *
 * Offline: bundles two real recorded transcripts. Writes the zip to the path
 * given, or to ./<bundle name>.zip in the current directory.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildBundle, type VideoContext } from '@vid2context/core';

const load = (file: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8'));

const bundle = await buildBundle([load('youtube-jNQXAC9IVRw.json'), load('youtube-cCPsdFdlshc.json')], {
  name: 'g-wagon-and-zoo',
  maxTokens: 8000,
  // A fixed date makes the zip byte-identical on every run. Leave it out to use the current time.
  createdAt: new Date('2026-11-14T00:00:00Z'),
});

process.stdout.write(
  `${bundle.files.length} files in ${bundle.root}/, context written by "${bundle.manifest.contextFormatter}"\n`,
);
for (const v of bundle.manifest.videos) {
  process.stdout.write(`  ${v.folder}/  ${v.title} (${v.origin}, about ${v.estimatedTokens} tokens)\n`);
}
process.stdout.write('\n');
for (const f of bundle.manifest.files) process.stdout.write(`  ${String(f.bytes).padStart(6)}  ${f.path}\n`);

const zip = new Uint8Array(await new Response(bundle.zip()).arrayBuffer());
const path = process.argv[2] ?? bundle.filename;
writeFileSync(path, zip);
process.stdout.write(`\nwrote ${path} (${zip.byteLength} bytes)\n`);
```

Output:

<!-- output: examples/library/context-bundle.ts -->
```text
20 files in g-wagon-and-zoo/, context written by "pack"
  videos/01-me-at-the-zoo/  Me at the zoo (creator-captions, about 548 tokens)
  videos/02-best-worst-g-wagon-years-reliability-interiors-engines/  Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked! (auto-captions, about 5626 tokens)

    2928  README.md
   24320  context.md
     699  index.md
    1061  llms.txt
    1618  videos/01-me-at-the-zoo/context.md
     218  videos/01-me-at-the-zoo/transcript.txt
    3064  videos/01-me-at-the-zoo/context.json
     912  videos/01-me-at-the-zoo/transcript.md
     415  videos/01-me-at-the-zoo/transcript.srt
     534  videos/01-me-at-the-zoo/transcript.vtt
    1374  videos/01-me-at-the-zoo/metadata.json
     254  videos/01-me-at-the-zoo/chapters.md
   22930  videos/02-best-worst-g-wagon-years-reliability-interiors-engines/context.md
   19867  videos/02-best-worst-g-wagon-years-reliability-interiors-engines/transcript.txt
   68915  videos/02-best-worst-g-wagon-years-reliability-interiors-engines/context.json
   22304  videos/02-best-worst-g-wagon-years-reliability-interiors-engines/transcript.md
   37993  videos/02-best-worst-g-wagon-years-reliability-interiors-engines/transcript.srt
   36200  videos/02-best-worst-g-wagon-years-reliability-interiors-engines/transcript.vtt
    1651  videos/02-best-worst-g-wagon-years-reliability-interiors-engines/metadata.json

wrote g-wagon-and-zoo.zip (85192 bytes)
```

## Get a transcript from a URL

`getVideoContext` resolves the input (a URL, a YouTube id, a podcast episode or a local file), fetches metadata, then walks the fallback chain: creator captions, auto-captions, then audio and speech-to-text. Every step is recorded in `attempts`. Errors are `Vid2ContextError` with a stable `code` and a `hint`.

<!-- example: examples/library/get-transcript.ts -->
```ts
/**
 * Turn a video URL (or a local media file) into a VideoContext with the full
 * free-first pipeline: platform captions first, then speech-to-text through
 * the rung chain. Prints the transcript and every attempt that was made.
 *
 *   npx tsx examples/library/get-transcript.ts [url-or-file]
 *
 * Live, no keys needed. Keys in the environment or ./.env add more rungs.
 * Default input: "Me at the zoo", the first YouTube video.
 */
import { formatTimestamp, getVideoContext, render, Vid2ContextError } from '@vid2context/core';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';

loadEnvFiles();
const registry = createRegistry();
const ctx = createNodeContext();
const input = process.argv[2] ?? 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

try {
  const context = await getVideoContext(registry, input, { mode: 'auto', language: 'en' }, ctx);
  const { metadata, transcript } = context;
  process.stdout.write(`${metadata.title}\n`);
  process.stdout.write(`${metadata.channel?.name ?? 'unknown channel'}, ${formatTimestamp(metadata.durationSec ?? 0)}, `);
  process.stdout.write(`${transcript.origin} (${transcript.language}) from ${transcript.producer}\n\n`);
  process.stdout.write(render(context, 'text', { timestamps: true }));
  process.stdout.write('\nAttempts:\n');
  for (const a of context.attempts) process.stdout.write(`  ${a.stage.padEnd(8)} ${a.outcome.padEnd(7)} ${a.id}\n`);
} catch (err) {
  // User-facing errors carry a stable code and a hint on how to recover.
  if (err instanceof Vid2ContextError) console.error(`${err.code}: ${err.message}\nhint: ${err.hint ?? ''}`);
  else console.error(err);
  process.exitCode = 1;
}
```

Recorded run, no keys:

```text
Me at the zoo
jawed, 0:19, creator-captions (en) from youtube-captions

[0:01] All right, so here we are, in front of the elephants
[0:05] the cool thing about these guys is that they have really...
[0:07] really really long trunks
[0:12] and that's cool
[0:14] (baaaaaaaaaaahhh!!)
[0:16] and that's pretty much all there is to say

Attempts:
  resolve  ok      youtube
  metadata ok      youtube
  captions ok      youtube-captions
```

YouTube often refuses caption requests from cloud servers. A later run from the same cloud VM was blocked, and with the keyless Whisper host rate limited too, the example printed the error code and hint and exited 1:

```text
blocked: YouTube captions en: YouTube answered HTTP 429 (automated-traffic block).
hint: YouTube is refusing requests from this IP address, which is common on cloud servers. Fixes, best first: run vid2context on your own machine; route the server through your home network (docs/guides/cloudflare-tunnel.md); set YOUTUBE_COOKIE to a signed-in Cookie header (ties requests to your account); or install the yt-dlp provider. Then wait for the block to clear (YOUTUBE_BLOCK_COOLDOWN_SEC).
```

## Transcribe a local file

A file path goes through the same pipeline. `mode: 'stt'` skips caption lookups and goes straight to speech-to-text. With no keys, the keyless OVH Whisper rung does the work. A local server or a free key runs first when one is configured. See [Speech-to-text](../guides/speech-to-text.md).

<!-- example: examples/library/transcribe-file.ts -->
```ts
/**
 * Transcribe a local audio or video file with speech-to-text. With no keys,
 * the keyless Whisper rung does the work; a local server (speaches,
 * whisper.cpp) or a free key (Groq, Gemini) runs first when configured.
 *
 *   npx tsx examples/library/transcribe-file.ts [file]
 *
 * Live, no keys needed. Sends the audio to the first enabled speech-to-text
 * rung. Default file: NASA's public-domain recording of Neil Armstrong's
 * first words on the Moon (24 seconds).
 */
import { fileURLToPath } from 'node:url';
import { attemptsOf, getVideoContext, render, Vid2ContextError } from '@vid2context/core';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';

loadEnvFiles();
const file = process.argv[2] ?? fileURLToPath(new URL('../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url));

try {
  const context = await getVideoContext(createRegistry(), file, { mode: 'stt', language: 'en' }, createNodeContext());
  process.stdout.write(render(context, 'text', { timestamps: true }));
  const stt = context.attempts.filter((a) => a.stage === 'stt');
  process.stdout.write(`\nTranscribed by ${context.transcript.producer} after ${stt.length} speech-to-text attempt(s):\n`);
  for (const a of stt) process.stdout.write(`  ${a.outcome.padEnd(7)} ${a.id}${a.reason ? ` (${a.reason})` : ''}\n`);
} catch (err) {
  if (!(err instanceof Vid2ContextError)) throw err;
  // Every rung failed: say why each one did, and how to recover.
  console.error(`${err.code}: ${err.message}\nhint: ${err.hint ?? ''}`);
  for (const a of attemptsOf(err))
    console.error(`  ${a.stage.padEnd(8)} ${a.outcome.padEnd(7)} ${a.id}${a.reason ? ` (${a.reason})` : ''}`);
  process.exitCode = 1;
}
```

Recorded run, no keys:

```text
[0:03] I'm going to step off the limb now.
[0:14] That's one small step for man, one giant leap for mankind.

Transcribed by stt/ovh/whisper-large-v3-turbo after 1 speech-to-text attempt(s):
  ok      stt/ovh/whisper-large-v3-turbo
```

On a machine where a configured rung fails (here, a Cloudflare token the service rejected), the chain falls through and the attempts say why:

```text
Transcribed by stt/ovh/whisper-large-v3-turbo after 3 speech-to-text attempt(s):
  error   stt/cloudflare/@cf/openai/whisper-large-v3-turbo (auth-401)
  error   stt/cloudflare/@cf/openai/whisper (auth-401)
  ok      stt/ovh/whisper-large-v3-turbo
```

## Ask a question with citations

`ask` picks the transcript excerpts that matter, numbers them, and has a model answer with `[n]` citations. Each citation is checked: it maps to a real excerpt with a timestamp link, and numbers that match no excerpt are removed from the answer and listed in `unverified`. See [Ask](../guides/ask.md).

<!-- example: examples/library/ask-a-video.ts -->
```ts
/**
 * Ask a question about a video and get an answer whose [n] citations are
 * checked against the transcript: each one maps to a real excerpt with a
 * timestamp link, and numbers that match no excerpt are removed.
 *
 *   npx tsx examples/library/ask-a-video.ts ["your question"]
 *
 * Live, no keys needed: the transcript is a real recorded one, and the
 * answer comes from the free-first LLM chain (a local model or a free key
 * when configured, else the keyless hosts).
 */
import { readFileSync } from 'node:fs';
import { ask } from '@vid2context/ask';
import { formatTimestamp, MemoryStorage, type VideoContext } from '@vid2context/core';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';

loadEnvFiles();
const context: VideoContext = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8'),
);
const question = process.argv[2] ?? 'Which G-Wagon engine do they call the most reliable, and why?';

const result = await ask(
  createRegistry(),
  { question, contexts: [context], storage: new MemoryStorage(), maxTokens: 600 },
  createNodeContext(),
);

process.stdout.write(`Q: ${question}\n\n${result.answer}\n\nCitations:\n`);
for (const c of result.citations) {
  process.stdout.write(`  [${c.n}] ${formatTimestamp(c.startSec)} ${c.url ?? ''}\n      "${c.quote ?? ''}"\n`);
}
if (result.unverified.length)
  process.stdout.write(`Removed citations that matched no excerpt: ${result.unverified.join(', ')}\n`);
process.stdout.write(`\nAnswered by ${result.rung} (${result.sources.length} excerpts sent)\n`);
```

Recorded run, no keys (the model is whichever free rung answered first):

```text
Q: Which G-Wagon engine do they call the most reliable, and why?

The M113 V8 is called the most reliable G-Wagon engine because it is all-aluminum, lightweight, has a simple single-overhead-cam design with timing chains and two spark plugs per cylinder, and parts are cheap and available worldwide. [2]

Citations:
  [2] 1:00 https://www.youtube.com/watch?v=cCPsdFdlshc&t=60s
      "of the engine options real quick on the first one the 2000 G500 now there's a"

Answered by llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free (18 excerpts sent)
```

## A playlist into one context pack

`expandInput` turns a playlist, channel or feed into video refs. Each one goes through the pipeline, and `renderMany` writes one pack with a table of contents and citation instructions. Content that does not fit the budget is cut where marked, never silently. Progress goes to stderr and the pack to stdout, so `> pack.md` stays clean.

<!-- example: examples/library/expand-playlist.ts -->
```ts
/**
 * Expand a playlist, channel or feed into its videos, then fetch the first
 * few transcripts and combine them into one context pack for a model.
 *
 *   npx tsx examples/library/expand-playlist.ts [playlist-url] [count]
 *
 * Live, no keys needed. Default: a public YouTube playlist, first 3 videos.
 * A video that fails is reported on stderr and the others still go in.
 */
import { estimateTokens, expandInput, getVideoContext, renderMany, type VideoContext } from '@vid2context/core';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';

loadEnvFiles();
const registry = createRegistry();
const ctx = createNodeContext();
const input = process.argv[2] ?? 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
const count = Number(process.argv[3] ?? 3);

const refs = await expandInput(registry, input, ctx, { limit: count });
process.stderr.write(`${refs.length} videos\n`);

const contexts: VideoContext[] = [];
for (const ref of refs) {
  try {
    contexts.push(await getVideoContext(registry, ref.url ?? ref.input, {}, ctx));
    process.stderr.write(`  ok      ${ref.url}\n`);
  } catch (err) {
    process.stderr.write(`  failed  ${ref.url}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// One Markdown document with citation instructions, sized to a token budget.
const pack = renderMany(contexts, 'pack', { maxTokens: 12_000 });
process.stdout.write(pack);
process.stderr.write(`pack: ${contexts.length} videos, about ${estimateTokens(pack)} tokens\n`);
```

Recorded run, no keys (stderr, then the first lines of stdout):

```text
3 videos
  ok      https://www.youtube.com/watch?v=PzJL3aBRas8
  ok      https://www.youtube.com/watch?v=1Xx1fmHIsiA
  ok      https://www.youtube.com/watch?v=AS6LYBzFtEU
pack: 3 videos, about 11951 tokens
# Video context pack

This document holds the transcripts and metadata of 3 videos (49:16 in total), prepared by vid2context for an AI model to read. Each transcript paragraph starts with the time it begins in the video, in brackets; linked times open the video at that moment.

Citation rule: when you use something from a video, cite it as [Title @ m:ss](link), using the time and link of the paragraph you drew on (or [Title @ m:ss] when the video has no link).

Some content was left out to fit a budget of 12000 tokens. Each cut is marked where it happened.

## Contents

1. [Why I'm Selling My DREAM G-Wagon (Custom Build 2015 Mercedes G550)](#video-1-why-im-selling-my-dream-g-wagon-custom-build-2015-mercedes-g550) (11:37)
2. [Owning a 2018 Mercedes G550 For 2 Years: Costs, Fuel Economy, & More](#video-2-owning-a-2018-mercedes-g550-for-2-years-costs-fuel-economy--more) (15:06)
3. [NEW vs OLD G-Wagon: Brutal Showdown Reveals a Clear Winner](#video-3-new-vs-old-g-wagon-brutal-showdown-reveals-a-clear-winner) (22:33)
```
