/**
 * Live: a real question over the G-Wagon fixture through the real keyless
 * chain. Run with LIVE=1. Checks that every citation opens the video where
 * the transcript contains words of the sentence that cites it.
 */
import { clearCooldowns, createContext, segmentsToText, sliceSegments } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { ask } from '../src/engine.ts';
import { GWAGON_URL, loadContext, makeRegistry, makeStorage } from './helpers.ts';

const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 3));

describe.skipIf(!process.env.LIVE)('live ask over the keyless chain', () => {
  it('cites timestamps whose transcript supports the claims', async () => {
    clearCooldowns();
    const { storage } = await makeStorage();
    const ctx = createContext({ runtime: 'node', env: { VID2CONTEXT_LOG_LEVEL: 'warn' } });
    const r = await ask(
      makeRegistry(),
      {
        question: 'What engine and transmission does the 2015 G550 have, and how reliable is it?',
        inputs: [GWAGON_URL],
        storage,
      },
      ctx,
    );
    console.error(r.answer);
    for (const c of r.citations) console.error(`[${c.n}] ${c.url} "${c.quote}"`);
    expect(r.citations.length).toBeGreaterThan(0);
    const segments = loadContext('youtube-cCPsdFdlshc.json').transcript.segments;
    const sentences = r.answer.split(/(?<=[.!?\n])\s+/);
    for (const c of r.citations) {
      const claim = sentences.filter((s) => s.includes(`[${c.n}]`)).join(' ');
      const around = words(segmentsToText(sliceSegments(segments, c.startSec - 15, c.startSec + 30)));
      const shared = [...words(claim)].filter((w) => around.has(w));
      expect(shared.length, `citation [${c.n}] at ${c.startSec}s shares no words with "${claim}"`).toBeGreaterThan(0);
    }
  }, 180_000);
});
