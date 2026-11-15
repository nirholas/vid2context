import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkTranscript, type TranscriptChunk, transcriptOutline } from '../../src/chunk/index.ts';
import { item as at, isCut, segmentTokens } from '../../src/chunk/spans.ts';
import { Vid2ContextError } from '../../src/errors.ts';
import { segmentsToText } from '../../src/segments.ts';
import { estimateTokens } from '../../src/tokens.ts';
import type { VideoContext } from '../../src/types.ts';

const load = (f: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/contexts/${f}`, import.meta.url), 'utf8'));
const zoo = load('youtube-jNQXAC9IVRw.json');
const gwagon = load('youtube-cCPsdFdlshc.json');

/** Invariants every chunking must keep, checked on real data. */
function checkInvariants(
  ctx: VideoContext,
  chunks: TranscriptChunk[],
  maxTokens: number,
  overlapTokens = 0,
  /** Time windows may cut at a plain segment boundary when no pause or sentence end is near the target. */
  checkCuts = true,
): void {
  const segs = ctx.transcript.segments;
  const tokens = segmentTokens(segs);
  const core = maxTokens - overlapTokens;
  let expectedCoreStart = 0;
  chunks.forEach((c, i) => {
    const [first, last] = c.segmentRange;
    const coreStart = first + c.overlapSegments;
    // Coverage and order: core ranges partition the segments, in order.
    expect(coreStart, `chunk ${i} core start`).toBe(expectedCoreStart);
    expect(last).toBeGreaterThanOrEqual(coreStart);
    expectedCoreStart = last + 1;
    // Text, tokens and times match the segments.
    expect(c.index).toBe(i);
    expect(c.text).toBe(segmentsToText(segs.slice(first, last + 1)));
    expect(c.tokens).toBe(estimateTokens(c.text));
    expect(c.startSec).toBe(at(segs, first).startSec);
    expect(c.endSec).toBe(at(segs, last).endSec);
    if (i > 0) {
      expect(c.startSec).toBeGreaterThanOrEqual(at(chunks, i - 1).startSec);
      expect(c.endSec).toBeGreaterThanOrEqual(at(chunks, i - 1).endSec);
    }
    // Budget: only a lone oversized segment may exceed it.
    if (c.tokens > maxTokens) {
      expect(last - first, `chunk ${i} over budget with several segments`).toBe(0);
      expect(tokens[first]).toBeGreaterThan(core);
    }
    // Overlap: whole segments repeated from the end of the previous chunk, within overlapTokens.
    if (c.overlapSegments > 0) {
      const prev = at(chunks, i - 1);
      expect(first).toBeGreaterThanOrEqual(at(prev.segmentRange, 0) + prev.overlapSegments);
      expect(coreStart).toBe(at(prev.segmentRange, 1) + 1);
      expect(tokens.slice(first, coreStart).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(overlapTokens);
    }
    // Cuts: a chunk ends on a sentence end or pause, or because the next segment would not fit.
    if (checkCuts && i < chunks.length - 1 && at(chunks, i + 1).chapterIndex === c.chapterIndex) {
      const withNext = tokens.slice(coreStart, last + 2).reduce((a, b) => a + b, 0);
      expect(isCut(segs, last) || withNext > core, `chunk ${i} ends mid-sentence while the next segment fits`).toBe(true);
    }
  });
  expect(expectedCoreStart).toBe(segs.length);
}

describe('chunkTranscript', () => {
  it('chunks a video with chapters by chapter, never across a chapter boundary', () => {
    const chunks = chunkTranscript(zoo, { maxTokens: 20 });
    checkInvariants(zoo, chunks, 20);
    const sections = transcriptOutline(zoo).sections;
    for (const c of chunks) {
      expect(c.chapterIndex).toBeDefined();
      const s = at(sections, c.chapterIndex ?? -1);
      expect(c.chapterTitle).toBe(s.title);
      expect(c.startSec).toBeGreaterThanOrEqual(s.startSec);
      expect(at(zoo.transcript.segments, c.segmentRange[1]).startSec).toBeLessThan(s.endSec);
    }
    // "Intro" holds only the first segment, so it is a chunk of its own even though the next would fit.
    expect(at(chunks, 0).text).toBe('All right, so here we are, in front of the elephants');
    expect(at(chunks, 0).chapterTitle).toBe('Intro');
    expect(chunks.slice(1).every((c) => c.chapterTitle === 'The cool thing')).toBe(true);
  });

  it('defaults to tokens mode for a video without chapters and fills each budget', () => {
    for (const maxTokens of [200, 1000, 4000]) {
      const chunks = chunkTranscript(gwagon, { maxTokens });
      checkInvariants(gwagon, chunks, maxTokens);
      expect(chunks.every((c) => c.chapterIndex === undefined)).toBe(true);
      const total = chunks.reduce((a, c) => a + c.tokens, 0);
      // Cuts land on pauses, so chunks average well over half the budget.
      expect(total / chunks.length).toBeGreaterThan(maxTokens / 2);
      if (maxTokens === 200) expect(chunks.length).toBeGreaterThan(20);
    }
  });

  it('repeats whole segments as overlap and stays within budget including it', () => {
    for (const [maxTokens, overlapTokens] of [
      [200, 40],
      [1000, 100],
      [4000, 400],
    ] as const) {
      const chunks = chunkTranscript(gwagon, { maxTokens, overlapTokens });
      checkInvariants(gwagon, chunks, maxTokens, overlapTokens);
      expect(chunks.slice(1).every((c) => c.overlapSegments > 0)).toBe(true);
    }
    const chapterChunks = chunkTranscript(zoo, { maxTokens: 30, overlapTokens: 10 });
    checkInvariants(zoo, chapterChunks, 30, 10);
    // The first chunk of each chapter starts clean.
    for (const [i, c] of chapterChunks.entries()) {
      if (i === 0 || at(chapterChunks, i - 1).chapterIndex !== c.chapterIndex) expect(c.overlapSegments).toBe(0);
    }
  });

  it('cuts time windows of about targetSec and labels chunks with their chapter in time mode', () => {
    const chunks = chunkTranscript(gwagon, { maxTokens: 4000, by: 'time', targetSec: 120 });
    checkInvariants(gwagon, chunks, 4000, 0, false);
    for (const c of chunks.slice(0, -1)) expect(c.endSec - c.startSec).toBeLessThan(120 * 1.5);
    expect(chunks.length).toBeGreaterThanOrEqual(7);
    const zooTime = chunkTranscript(zoo, { maxTokens: 4000, by: 'time', targetSec: 10 });
    checkInvariants(zoo, zooTime, 4000, 0, false);
    expect(at(zooTime, 0).chapterTitle).toBe('Intro');
  });

  it('keeps chunks whole in tokens mode even when the video has chapters', () => {
    const chunks = chunkTranscript(zoo, { maxTokens: 4000, by: 'tokens' });
    expect(chunks).toHaveLength(1);
    expect(at(chunks, 0).segmentRange).toEqual([0, 5]);
  });

  it('rejects bad budgets with bad-request', () => {
    for (const opts of [{ maxTokens: 0 }, { maxTokens: Number.NaN }, { maxTokens: 100, overlapTokens: 100 }]) {
      try {
        chunkTranscript(gwagon, opts);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(Vid2ContextError);
        expect((err as Vid2ContextError).code).toBe('bad-request');
        expect((err as Vid2ContextError).hint).toBeTruthy();
      }
    }
  });

  it('returns no chunks for an empty transcript', () => {
    const empty = { ...zoo, transcript: { ...zoo.transcript, segments: [] } };
    expect(chunkTranscript(empty, { maxTokens: 100 })).toEqual([]);
  });
});
