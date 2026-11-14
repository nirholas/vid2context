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
