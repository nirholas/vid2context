import { readdirSync, readFileSync } from 'node:fs';
import { encode as o200k } from 'gpt-tokenizer/encoding/o200k_base';
import llama3 from 'llama3-tokenizer-js';
import { describe, expect, it } from 'vitest';
import { segmentsToText } from '../../src/segments.ts';
import { estimateTokens } from '../../src/tokens.ts';
import type { VideoContext } from '../../src/types.ts';
import { srtText } from './srt.ts';

const context = (f: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/contexts/${f}`, import.meta.url), 'utf8'));
const llama = (t: string) => llama3.encode(t, { bos: false, eos: false }).length;
const err = (est: number, real: number) => Math.abs(est - real) / real;

describe('estimateTokens', () => {
  it('returns 0 for empty text and at least 1 otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(' ')).toBe(1);
  });

  // Bound documented in docs/chunking.md: English transcripts within 10 percent.
  it('stays within 10 percent of o200k and Llama 3 on the real English transcript', () => {
    const text = segmentsToText(context('youtube-cCPsdFdlshc.json').transcript.segments);
    const est = estimateTokens(text);
    expect(err(est, o200k(text).length)).toBeLessThan(0.1);
    expect(err(est, llama(text))).toBeLessThan(0.1);
  });

  // Bound documented in docs/chunking.md: every measured script within 25 percent of o200k and Llama 3.
  it('stays within 25 percent of o200k and Llama 3 on real captions in every measured script', () => {
    const dir = new URL('./fixtures/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.srt'));
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const f of files) {
      const text = srtText(readFileSync(new URL(f, dir), 'utf8'));
      const est = estimateTokens(text);
      expect(err(est, o200k(text).length), `${f} vs o200k`).toBeLessThan(0.25);
      expect(err(est, llama(text)), `${f} vs llama3`).toBeLessThan(0.25);
    }
  });

  it('matches the committed accuracy report, so docs/chunking.md cannot drift from the code', () => {
    const report = JSON.parse(readFileSync(new URL('./token-accuracy.json', import.meta.url), 'utf8')) as {
      rows: { sample: string; estimate: number }[];
    };
    const dir = new URL('./fixtures/', import.meta.url);
    for (const row of report.rows.filter((r) => r.sample.startsWith('commons-'))) {
      const text = srtText(readFileSync(new URL(`${row.sample}.srt`, dir), 'utf8'));
      expect(estimateTokens(text), row.sample).toBe(row.estimate);
    }
    const g = report.rows.find((r) => r.sample === 'youtube-cCPsdFdlshc transcript');
    expect(g?.estimate).toBe(estimateTokens(segmentsToText(context('youtube-cCPsdFdlshc.json').transcript.segments)));
  });

  it('is fast enough for hour-long transcripts', () => {
    const text = segmentsToText(context('youtube-cCPsdFdlshc.json').transcript.segments).repeat(10);
    const t0 = performance.now();
    estimateTokens(text);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
