/**
 * Live checks against real YouTube and the real keyless LLM rungs. Run with
 * `LIVE=1 npx vitest run packages/research/test/live.test.ts`. They print the
 * result size next to the full transcripts so the token saving is visible.
 */
import { clearCooldowns, createContext, MemoryStorage } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { listCaptionLanguages } from '../src/languages.ts';
import { keyMoments } from '../src/moments.ts';
import { renderResearch, research } from '../src/research.ts';
import { GWAGON, makeRegistry } from './helpers.ts';

// Three videos of the G-Wagon buyer's playlist PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b.
const PLAYLIST_VIDEOS = [
  'https://www.youtube.com/watch?v=cCPsdFdlshc',
  'https://www.youtube.com/watch?v=PzJL3aBRas8',
  'https://www.youtube.com/watch?v=1Xx1fmHIsiA',
];

describe.skipIf(!process.env.LIVE)('live research tools', () => {
  const ctx = createContext({ runtime: 'node', env: {} });
  const registry = makeRegistry();

  it('research_videos answers a buying question in far fewer tokens than the transcripts', async () => {
    const r = await research(PLAYLIST_VIDEOS, 'which years have engine reliability problems', {}, { registry, ctx, storage: new MemoryStorage() });
    console.error(renderResearch(r));
    console.error(`research: ${r.tokens} tokens of excerpts vs ${r.transcriptTokens} tokens of full transcripts`);
    expect(r.failed).toEqual([]);
    expect(r.results).toHaveLength(3);
    expect(r.results.some((v) => v.excerpts.length > 0)).toBe(true);
    expect(r.tokens).toBeLessThanOrEqual(2200);
    expect(r.transcriptTokens).toBeGreaterThan(5 * r.tokens);
  });

  it('lists caption languages from the live player', async () => {
    const r = await listCaptionLanguages(GWAGON, { registry, ctx, storage: null });
    expect(r.tracks.length).toBeGreaterThan(0);
    expect(r.translationTargets.length).toBeGreaterThan(0);
  });

  it('picks key moments with the keyless chain and verifies them', async () => {
    clearCooldowns();
    const r = await keyMoments(GWAGON, { count: 6 }, { registry, ctx, storage: new MemoryStorage() });
    console.error(`key moments by ${r.rung}: ${r.moments.length} kept, ${r.dropped} dropped`);
    expect(r.moments.length).toBeGreaterThan(0);
    expect(r.rung).toMatch(/^llm\//);
  });
});
