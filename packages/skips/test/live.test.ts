/**
 * Live checks against the real SponsorBlock API. Run with LIVE=1. They print
 * the segments found and the first words of each removed sponsor read to
 * stderr, for the report.
 */
import { createContext, segmentsToText } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { applySkips, getSkipSegments } from '../src/index.ts';
import { officeContext, youtubeRef } from './fixtures.ts';

describe.skipIf(!process.env.LIVE)('SponsorBlock live', () => {
  const ctx = createContext({ runtime: 'node', env: {} });

  it('finds the sponsor reads in a real sponsored video and removes them from its transcript', async () => {
    const context = officeContext();
    const lookup = await getSkipSegments(context.metadata.ref, ctx);
    expect(lookup.looked).toBe(true);
    expect(lookup.segments.some((s) => s.category === 'sponsor')).toBe(true);
    const res = applySkips(context.transcript, lookup.segments);
    for (const r of res.removed) {
      console.error(
        `[live] ${r.segment.category} ${r.segment.startSec.toFixed(1)}-${r.segment.endSec.toFixed(1)} votes=${r.segment.votes} lines=${r.lines}: ${r.text.slice(0, 90)}`,
      );
    }
    console.error(`[live] fullVideo=${lookup.fullVideo?.category ?? 'none'} coveredSec=${res.coveredSec}`);
    expect(segmentsToText(res.transcript.segments)).not.toContain('They sponsored this video');
  });

  it('answers an empty result for the G-Wagon video, which has no segments', async () => {
    const lookup = await getSkipSegments(youtubeRef('cCPsdFdlshc'), ctx);
    expect(lookup).toMatchObject({ segments: [], looked: true });
  });

  it('answers an empty result for a category the prefix has none of (a real 404)', async () => {
    const lookup = await getSkipSegments(youtubeRef('CrO0Timw2z4'), ctx, { categories: ['exclusive_access'] });
    expect(lookup).toMatchObject({ segments: [], looked: true });
  });
});
