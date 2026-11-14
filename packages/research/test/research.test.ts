import { estimateTokens, segmentsToText } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { buildWindows } from '../src/bm25.ts';
import { type ResearchResult, renderResearch, research } from '../src/research.ts';
import { parseQuery, stem, tokenize } from '../src/text.ts';
import { ctxWith, filledStorage, GWAGON, loadContext, makeRegistry, playerRoute, ZOO } from './helpers.ts';

// Contexts come from a pre-filled MemoryStorage. testContext's default fetch
// rejects every call, so these tests also prove storage is used as the cache.
async function run(query: string, opts: Parameters<typeof research>[2] = {}, urls = [GWAGON, ZOO]): Promise<ResearchResult> {
  return research(urls, query, opts, { registry: makeRegistry(), ctx: testContext(), storage: await filledStorage() });
}

const gwagon = loadContext('cCPsdFdlshc');
const excerptsOf = (r: ResearchResult, id = 'youtube:cCPsdFdlshc') => r.results.find((v) => v.videoId === id)?.excerpts ?? [];

describe('text', () => {
  it('stems plurals, -ing, -ed and -ability onto the same stem', () => {
    expect(stem('engines')).toBe(stem('engine'));
    expect(stem('chains')).toBe(stem('chain'));
    expect(stem('reliability')).toBe(stem('reliable'));
    expect(stem('running')).toBe('run');
    expect(stem('worries')).toBe(stem('worried'));
    expect(stem('g500')).toBe('g500');
    expect(stem('speed')).toBe('speed');
  });

  it('tokenizes words and numbers, folding case and diacritics', () => {
    expect(tokenize('G-Wagon 2018, Café!')).toEqual(['g', 'wagon', '2018', 'cafe']);
  });

  it('parses quoted phrases and drops stop words from the terms', () => {
    const q = parseQuery('"timing chain" on the G500');
    expect(q.phraseText).toEqual(['timing chain']);
    expect(q.phrases).toEqual([[stem('timing'), stem('chain')]]);
    expect(q.terms).toEqual([stem('timing'), stem('chain'), 'g500']);
  });
});

describe('windows', () => {
  it('cuts the real transcript into ~30 s windows every ~15 s that cover every segment', () => {
    const segs = gwagon.transcript.segments;
    const windows = buildWindows(segs, 0);
    expect(windows[0]?.startSec).toBe(segs[0]?.startSec);
    expect(windows.at(-1)?.last).toBe(segs.length - 1);
    for (const w of windows) expect(w.endSec - w.startSec).toBeLessThan(40);
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1];
      const cur = windows[i];
      if (!prev || !cur) continue;
      expect(cur.first).toBeLessThanOrEqual(prev.last + 1);
    }
    // 1085 s of speech at a 15 s stride.
    expect(windows.length).toBeGreaterThan(65);
    expect(windows.length).toBeLessThan(75);
  });
});

describe('research', () => {
  it('ranks excerpts about the engine, best first, with citations', async () => {
    const r = await run('engine');
    const ex = excerptsOf(r);
    expect(ex.length).toBe(3);
    expect(ex.map((e) => e.startSec)).toEqual([43.76, 987.92, 800.56]);
    for (let i = 1; i < ex.length; i++) expect(ex[i - 1]?.score ?? 0).toBeGreaterThan(ex[i]?.score ?? 0);
    for (const e of ex) {
      expect(e.text.toLowerCase()).toContain('engine');
      expect(e.matched).toEqual(['engine']);
      expect(e.url).toBe(`https://www.youtube.com/watch?v=cCPsdFdlshc&t=${Math.floor(e.startSec)}s`);
    }
    expect(ex[0]?.timestamp).toBe('[0:43]');
    // The zoo video never says "engine": listed after the match, with no excerpt.
    expect(r.results.map((v) => v.videoId)).toEqual(['youtube:cCPsdFdlshc', 'youtube:jNQXAC9IVRw']);
    expect(excerptsOf(r, 'youtube:jNQXAC9IVRw')).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.suggestions).toBeUndefined();
  });

  it('keeps context within contextSec on each side and never repeats text between excerpts', async () => {
    const segs = gwagon.transcript.segments;
    for (const contextSec of [0, 10, 20]) {
      const r = await run('engine G500 interior', { contextSec, maxExcerpts: 5, maxTokens: 20_000 });
      const ex = excerptsOf(r);
      expect(ex.length).toBeGreaterThan(1);
      for (const e of ex) {
        const before = segs.filter((s) => s.endSec <= e.startSec && s.endSec > e.startSec - contextSec);
        const after = segs.filter((s) => s.startSec >= e.endSec && s.startSec < e.endSec + contextSec);
        expect(e.context.before).toBe(segmentsToText(before));
        expect(e.context.after).toBe(segmentsToText(after));
        if (contextSec === 0) expect(e.context).toEqual({ before: '', after: '', fromSec: e.startSec, toSec: e.endSec });
      }
      // Merging: excerpts are farther apart than their two contexts, so no transcript text appears twice.
      const byTime = [...ex].sort((a, b) => a.startSec - b.startSec);
      for (let i = 1; i < byTime.length; i++) {
        const a = byTime[i - 1];
        const b = byTime[i];
        if (!a || !b) continue;
        expect(b.startSec - a.endSec).toBeGreaterThan(2 * contextSec);
        const shown = (e: typeof a) => segs.filter((s) => s.endSec > e.context.fromSec && s.startSec < e.context.toSec);
        const inA = new Set(shown(a));
        expect(shown(b).filter((s) => inA.has(s))).toEqual([]);
      }
    }
  });

  it('boosts an exact quoted phrase', async () => {
    const quoted = excerptsOf(await run('"timing chain" reliability'));
    const loose = excerptsOf(await run('timing chain reliability'));
    expect(quoted[0]?.startSec).toBe(77.84);
    expect(quoted[0]?.text).toContain('timing Chains');
    expect(quoted[0]?.score).toBeCloseTo((loose[0]?.score ?? 0) * 2, 2);
    const missing = await run('"chain timing"');
    expect(missing.notes[0]).toContain('The exact phrase "chain timing" was not found');
  });

  it('cuts to the token cap, dropping context before excerpts, and says so', async () => {
    const full = await run('engine G500 interior oil', { maxExcerpts: 5, maxTokens: 20_000 });
    expect(full.truncated).toBe(false);
    const capped = await run('engine G500 interior oil', { maxExcerpts: 5, maxTokens: 400 });
    expect(capped.truncated).toBe(true);
    expect(capped.notes.at(-1)).toMatch(/^To stay under 400 tokens, cut \d+ lower-ranked excerpts?/);
    const kept = excerptsOf(capped);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(excerptsOf(full).length);
    // The best excerpts survive, in the same order.
    expect(kept.map((e) => e.startSec)).toEqual(
      excerptsOf(full)
        .slice(0, kept.length)
        .map((e) => e.startSec),
    );
    expect(capped.tokens).toBeLessThan(full.tokens);
    expect(capped.tokens).toBeLessThanOrEqual(400 + estimateTokens(capped.notes.join('\n')) + 20);
  });

  it('reports the size of the excerpts against the whole transcripts', async () => {
    const r = await run('engine');
    expect(r.transcriptTokens).toBe(r.results.reduce((n, v) => n + v.transcriptTokens, 0));
    expect(r.transcriptTokens).toBeGreaterThan(4 * r.tokens);
    expect(r.tokens).toBe(estimateTokens(renderResearch(r)));
  });

  it('says plainly when nothing matches and suggests words the transcripts use', async () => {
    const r = await run('warranty coverage');
    expect(r.results.every((v) => v.excerpts.length === 0)).toBe(true);
    expect(r.notes[0]).toMatch(/^No excerpt in these 2 videos contains "warranty" or "coverage"/);
    expect(r.suggestions?.similar).toContain('covered');
    expect(r.suggestions?.topics.length).toBeGreaterThan(5);
    const typo = await run('reliabilty', {}, [GWAGON]);
    expect(typo.notes[0]).toMatch(/^No excerpt in this video contains "reliabilty"/);
    expect(typo.suggestions?.similar).toContain('reliable');
  });

  it('renders compact Markdown with the match in bold and a timestamp link', async () => {
    const out = renderResearch(await run('turbocharger'));
    expect(out).toContain('Research in 2 videos for: turbocharger');
    expect(out).toContain('## Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked! (Alliance Motorworks)');
    expect(out).toContain('[13:27](https://www.youtube.com/watch?v=cCPsdFdlshc&t=807s) (13:27 to 13:28, matched: turbocharger)');
    expect(out).toMatch(/\*\*[^*]*turbochargers[^*]*\*\*/);
  });

  it('keeps going when one input fails and lists the failure', async () => {
    const registry = makeRegistry();
    const r = await research(
      [
        GWAGON,
        'https://www.youtube.com/watch?v=xxxxxxxxxxx',
        'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
      ],
      'engine',
      {},
      { registry, ctx: ctxWith([playerRoute]), storage: await filledStorage() },
    );
    expect(excerptsOf(r).length).toBe(3);
    const bad = r.failed.find((f) => f.videoId === 'youtube:xxxxxxxxxxx');
    expect(bad).toMatchObject({ error: 'not-found', hint: expect.any(String) });
    // The playlist cannot be expanded in this test (no listing provider or no recorded listing); it is reported, not fatal.
    expect(r.failed.some((f) => f.input.includes('playlist?list='))).toBe(true);
  });

  it('rejects bad input with a hint', async () => {
    const deps = { registry: makeRegistry(), ctx: testContext(), storage: await filledStorage() };
    await expect(research([], 'engine', {}, deps)).rejects.toMatchObject({ code: 'bad-request' });
    await expect(research(Array(11).fill(GWAGON), 'engine', {}, deps)).rejects.toMatchObject({ code: 'bad-request' });
    await expect(research([GWAGON], 'the and of', {}, deps)).rejects.toMatchObject({
      code: 'bad-request',
      hint: expect.any(String),
    });
    await expect(research([GWAGON], 'engine', { contextSec: 500 }, deps)).rejects.toMatchObject({ code: 'bad-request' });
    await expect(
      research(['https://www.youtube.com/watch?v=xxxxxxxxxxx'], 'engine', {}, { ...deps, ctx: ctxWith([playerRoute]) }),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
