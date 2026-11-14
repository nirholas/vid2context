import { segmentsToText } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { applySkips, getSkipSegments, type SkipLookup } from '../src/index.ts';
import { officeContext, routes } from './fixtures.ts';

async function officeLookup(): Promise<SkipLookup> {
  return getSkipSegments(officeContext().metadata.ref, testContext({ fetch: replayFetch(routes) }));
}

describe('applySkips on a real sponsored transcript', () => {
  it('drop removes the sponsor reads and self-promotion, nothing else', async () => {
    const { transcript } = officeContext();
    const lookup = await officeLookup();
    const res = applySkips(transcript, lookup.segments);
    const before = segmentsToText(transcript.segments);
    const after = segmentsToText(res.transcript.segments);

    const read = (startSec: number) => res.removed.find((r) => Math.abs(r.segment.startSec - startSec) < 0.01);
    // The LiberNovo chair read.
    expect(read(603.067)?.segment.category).toBe('sponsor');
    expect(read(603.067)?.text).toContain('LiberNovus sent these over. They sponsored this video');
    // The Nanoleaf mention.
    expect(read(690.53)?.text).toContain('Did we mention that NanoLeaf sponsored the video?');
    // The store plug.
    expect(read(963.327)?.segment.category).toBe('selfpromo');
    expect(read(963.327)?.text).toContain('LTTstore.com, baby');

    expect(before).toContain('They sponsored this video');
    expect(after).not.toContain('They sponsored this video');
    expect(after).not.toContain('LTTstore.com');
    expect(after).not.toContain('Did we mention that NanoLeaf sponsored');
    // The actual content stays.
    expect(after).toContain('Remember when I teased earlier that home assistant automations');
    expect(after).not.toContain('including setting up a home assistant server'); // said in the preview
    expect(res.transcript.segments.length).toBe(transcript.segments.length - res.removed.reduce((n, r) => n + r.lines, 0));
    expect(res.coveredSec).toBe(192.307);
    expect(res.transcript.producer).toBe('youtube-captions+skips');
    expect(res.transcript.origin).toBe('auto-captions');
  });

  it('a whole-video sponsorship label removes nothing by itself', async () => {
    const { transcript } = officeContext();
    const lookup = await officeLookup();
    expect(lookup.fullVideo).toBeDefined();
    const res = applySkips(transcript, lookup.fullVideo ? [lookup.fullVideo] : []);
    expect(res.transcript.segments).toHaveLength(transcript.segments.length);
    expect(res.removed).toEqual([]);
    expect(res.coveredSec).toBe(0);
  });

  it('mark keeps every line unchanged and lists the indexes inside each span', async () => {
    const { transcript } = officeContext();
    const lookup = await officeLookup();
    const res = applySkips(transcript, lookup.segments, { mode: 'mark' });
    expect(res.transcript.segments.map((s) => s.text)).toEqual(transcript.segments.map((s) => s.text));
    expect(res.transcript.segments.every((s) => s.speaker === undefined)).toBe(true);
    const chair = res.removed.find((r) => r.segment.startSec === 603.067);
    expect(chair?.lines).toBeGreaterThan(10);
    expect(chair?.indexes.map((i) => transcript.segments[i]?.text).join(' ')).toContain('They sponsored this video');
    // drop removes exactly the lines mark points at.
    const dropped = applySkips(transcript, lookup.segments);
    const marked = new Set(res.removed.flatMap((r) => r.indexes));
    expect(dropped.transcript.segments.map((s) => s.startSec)).toEqual(
      transcript.segments.filter((_, i) => !marked.has(i)).map((s) => s.startSec),
    );
  });

  it('minOverlap decides how much of a line must be inside a span', async () => {
    const { transcript } = officeContext();
    const lookup = await officeLookup();
    const loose = applySkips(transcript, lookup.segments, { minOverlap: 0.1 });
    const strict = applySkips(transcript, lookup.segments, { minOverlap: 1 });
    const half = applySkips(transcript, lookup.segments);
    expect(loose.transcript.segments.length).toBeLessThan(half.transcript.segments.length);
    expect(strict.transcript.segments.length).toBeGreaterThan(half.transcript.segments.length);
    expect(() => applySkips(transcript, lookup.segments, { minOverlap: 0 })).toThrow(/minOverlap/);
    expect(() => applySkips(transcript, lookup.segments, { minOverlap: 1.5 })).toThrow(/minOverlap/);
  });

  it('never mutates the input transcript or shares line objects with the result', async () => {
    const context = officeContext();
    const snapshot = structuredClone(context.transcript);
    const lookup = await officeLookup();
    const segmentsSnapshot = structuredClone(lookup.segments);
    const res = applySkips(context.transcript, lookup.segments);
    const marked = applySkips(context.transcript, lookup.segments, { mode: 'mark' });
    expect(context.transcript).toEqual(snapshot);
    expect(lookup.segments).toEqual(segmentsSnapshot);
    expect(res.transcript).not.toBe(context.transcript);
    expect(marked.transcript.segments[0]).not.toBe(context.transcript.segments[0]);
    const first = marked.transcript.segments[0];
    if (first) first.text = 'changed';
    expect(context.transcript.segments[0]?.text).toBe(snapshot.segments[0]?.text);
  });

  it('applying twice does not stack the producer suffix', async () => {
    const { transcript } = officeContext();
    const lookup = await officeLookup();
    const once = applySkips(transcript, lookup.segments).transcript;
    expect(applySkips(once, lookup.segments).transcript.producer).toBe('youtube-captions+skips');
  });
});
