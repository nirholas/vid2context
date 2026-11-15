import { describe, expect, it } from 'vitest';
import type { RecordedRef } from '../src/refs.ts';
import { summarize } from '../src/results.ts';
import { FILLERS_VARIANT, RAW_VARIANT, RULES_VARIANT, scoreOfflineVariants } from '../src/suites/cleanup.ts';
import { fixtureRef, sharedContext } from './helpers.ts';

/** "Me at the zoo": creator captions (shared fixture) and unpunctuated auto-captions of a reupload of the same audio. */
function zooPair(): { creator: RecordedRef; auto: RecordedRef } {
  const ctx = sharedContext('youtube-jNQXAC9IVRw.json');
  const t = ctx.transcript;
  const creator: RecordedRef = {
    videoId: t.ref.id,
    language: t.language,
    origin: t.origin,
    producer: t.producer,
    recordedAt: t.createdAt.slice(0, 10),
    segments: t.segments,
  };
  return { creator, auto: fixtureRef('youtube-9Pd5fi1DCb8.auto-captions.en.json') };
}

describe('cleanup suite scoring on a real creator and auto-caption pair', () => {
  it('scores raw, rules and fillers variants from the same raw input', async () => {
    const { creator, auto } = zooPair();
    const item = { id: 'zoo', language: 'en', url: 'https://www.youtube.com/watch?v=9Pd5fi1DCb8' };
    const rows = await scoreOfflineVariants(item, auto.videoId, creator, auto);
    expect(rows.map((r) => r.rung)).toEqual([RAW_VARIANT, RULES_VARIANT, FILLERS_VARIANT]);
    expect(rows.every((r) => r.outcome === 'ok' && r.wer && r.punctuation)).toBe(true);

    const [raw, rules] = rows;
    if (!raw?.punctuation || !rules?.punctuation || !raw.wer || !rules.wer) throw new Error('missing scores');
    // The raw auto-captions have no punctuation at all; rule-based sentences add some.
    expect(raw.punctuation.punctuation.tp).toBe(0);
    expect(rules.punctuation.punctuation.tp + rules.punctuation.punctuation.fp).toBeGreaterThan(0);
    // Cleanup is an added layer: it must not change what was said beyond a few words.
    expect(Math.abs(rules.wer.rate - raw.wer.rate)).toBeLessThan(0.1);
    expect(rules.cleanup?.steps.length).toBeGreaterThan(0);
    expect(raw.cleanup).toBeUndefined();

    const summary = summarize(rows);
    expect(summary.map((s) => s.rung)).toEqual([RAW_VARIANT, RULES_VARIANT, FILLERS_VARIANT]);
    expect(summary.every((s) => s.ok === 1 && s.punctuationF1 !== undefined)).toBe(true);
  });
});
