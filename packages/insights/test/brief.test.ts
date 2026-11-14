/**
 * buildBrief and extract replayed from LLM responses recorded LIVE from the
 * keyless chain (scripts/record-llm.ts, test/fixtures/llm/README.md), over
 * real G-Wagon series transcripts.
 */
import { clearCooldowns, Registry, type VideoContext } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Brief, buildBrief, classify, extract, type Point, verifyCitations, verifyQuote } from '../src/index.ts';
import { gwagonContext, loadRecording, replayRecording } from './recording.ts';
import { SCENARIOS } from './scenarios.ts';

const registry = new Registry([llm], 'node');
const noWait = async () => {};

beforeEach(() => {
  clearCooldowns();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

function contextsFor(videos: number[]): VideoContext[] {
  return videos.map((i) => gwagonContext(i));
}

/** Every citation must re-verify from scratch at the exact time it carries. */
function expectVerified(brief: Brief, contexts: VideoContext[]): void {
  const byId = new Map(contexts.map((c) => [c.metadata.ref.id, c]));
  for (const c of brief.claims) {
    const r = verifyQuote(byId.get(c.videoId) as VideoContext, c.citation.quote, c.citation.startSec);
    expect(r.ok, `${c.id} "${c.citation.quote}"`).toBe(true);
    expect(r.startSec).toBe(c.citation.startSec);
    expect(c.citation.url).toBe(`https://www.youtube.com/watch?v=${c.videoId.slice(8)}&t=${Math.floor(c.citation.startSec)}s`);
  }
}

function expectClassified(points: Point[]): void {
  for (const p of points) {
    const supportVideos = new Set(p.support.map((c) => c.videoId));
    if (p.kind === 'consensus') {
      expect(supportVideos.size).toBeGreaterThanOrEqual(2);
      expect(p.oppose).toEqual([]);
    }
    if (p.kind === 'disagreement') {
      expect(p.support.length).toBeGreaterThan(0);
      expect(p.oppose.length).toBeGreaterThan(0);
      expect(p.counter).toBeTruthy();
    }
    if (p.kind === 'single-source') expect(supportVideos.size).toBe(1);
  }
}

async function runBrief(name: 'brief-single' | 'brief-map-reduce') {
  const s = SCENARIOS[name];
  const contexts = contextsFor(s.videos);
  const fetch = replayRecording(loadRecording(name));
  const brief = await buildBrief(contexts, { ...s.options, sleep: noWait }, { registry, ctx: testContext({ fetch }) });
  return { brief, contexts, fetch };
}

describe('buildBrief, single pass (replayed)', () => {
  it('produces a cited buyer guide where every claim passed verification', async () => {
    const { brief, contexts, fetch } = await runBrief('brief-single');
    expect(fetch.remaining()).toBe(0);
    expect(brief.strategy).toBe('single');
    expect(brief.template).toBe('buyer-guide');
    expect(brief.sources.map((s) => s.videoId)).toEqual(contexts.map((c) => c.metadata.ref.id));
    expect(brief.claims.length).toBeGreaterThan(5);
    expectVerified(brief, contexts);
    expectClassified([...brief.consensus, ...brief.disagreements, ...brief.singleSource]);
    expect(brief.rungs[0]?.step).toBe('single');
    expect(brief.rungs.every((r) => r.rung.startsWith('llm/'))).toBe(true);
  });

  it('renders Markdown with the question, topic sections, sources and the unverified appendix', async () => {
    const { brief } = await runBrief('brief-single');
    const md = brief.markdown;
    expect(md).toMatch(/^# Buyer guide: Which G-Wagon should I buy/);
    expect(md).toContain('**Question:**');
    expect(md).toContain('## Sources');
    expect(md).toMatch(/\[[^\]]+ @ \d+:\d\d\]\(https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}&t=\d+s\)/);
    if (brief.unverified.length > 0) expect(md).toContain('## Appendix: unverified claims');
    // Unverified quotes never appear as links.
    for (const u of brief.unverified) if (u.quote) expect(md).not.toContain(`: "${u.quote}"`);
  });
});

describe('buildBrief, map-reduce (replayed)', () => {
  it('maps each chunk, reduces once, and records which rung served each step', async () => {
    const { brief, contexts, fetch } = await runBrief('brief-map-reduce');
    expect(fetch.remaining()).toBe(0);
    expect(brief.strategy).toBe('map-reduce');
    const maps = brief.rungs.filter((r) => r.step === 'map');
    expect(maps.length).toBeGreaterThan(2);
    expect(new Set(maps.map((r) => r.videoId))).toEqual(new Set(contexts.map((c) => c.metadata.ref.id)));
    expect(brief.rungs.filter((r) => r.step === 'reduce').length).toBeGreaterThanOrEqual(1);
    expectVerified(brief, contexts);
    expectClassified([...brief.consensus, ...brief.disagreements, ...brief.singleSource]);
  });
});

describe('classify', () => {
  const contexts = [gwagonContext(0), gwagonContext(2)];
  // Real quotes from the two transcripts.
  const quoteA =
    contexts[0]?.transcript.segments
      .slice(60, 63)
      .map((s) => s.text)
      .join(' ') ?? '';
  const quoteB =
    contexts[1]?.transcript.segments
      .slice(40, 42)
      .map((s) => s.text)
      .join(' ') ?? '';
  const quoteA2 =
    contexts[0]?.transcript.segments
      .slice(200, 203)
      .map((s) => s.text)
      .join(' ') ?? '';
  const { verified } = verifyCitations(
    [
      {
        claim: 'a',
        quote: quoteA,
        videoId: 'V1',
        startSec: contexts[0]?.transcript.segments[60]?.startSec ?? 0,
        topic: 'Engines',
      },
      {
        claim: 'b',
        quote: quoteB,
        videoId: 'V2',
        startSec: contexts[1]?.transcript.segments[40]?.startSec ?? 0,
        topic: 'engine',
      },
      {
        claim: 'c',
        quote: quoteA2,
        videoId: 'V1',
        startSec: contexts[0]?.transcript.segments[200]?.startSec ?? 0,
        topic: 'engines',
      },
    ],
    contexts,
  );

  it('verified the three real quotes', () => {
    expect(verified.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('marks consensus only with two distinct videos', () => {
    const sameVideo = classify([{ topic: 'engines', points: [{ statement: 's', support: ['c1', 'c3'], oppose: [] }] }], verified);
    expect(sameVideo.find((p) => p.statement === 's')?.kind).toBe('single-source');
    const twoVideos = classify([{ topic: 'engines', points: [{ statement: 's', support: ['c1', 'c2'], oppose: [] }] }], verified);
    expect(twoVideos.find((p) => p.statement === 's')?.kind).toBe('consensus');
  });

  it('keeps both sides of a disagreement, drops unknown and reused ids, and keeps unmentioned claims', () => {
    const points = classify(
      [{ topic: 'Engines', points: [{ statement: 's', support: ['c1', 'c1', 'k9'], counter: 'not s', oppose: ['c2'] }] }],
      verified,
    );
    const d = points.find((p) => p.kind === 'disagreement');
    expect(d?.claimIds).toEqual({ support: ['c1'], oppose: ['c2'] });
    expect(points.find((p) => p.claimIds.support.includes('c3'))?.kind).toBe('single-source');
    // Topic spellings that normalize the same are merged under the first one.
    expect(new Set(points.map((p) => p.topic))).toEqual(new Set(['Engines']));
  });
});

describe('extract (replayed)', () => {
  it('fills the buyer-guide template, repairs the broken first answer once, and keeps verified citations only', async () => {
    const s = SCENARIOS['extract-buyer'];
    const contexts = contextsFor(s.videos);
    const fetch = replayRecording(loadRecording('extract-buyer'));
    const r = await extract(contexts, { ...s.options, sleep: noWait }, { registry, ctx: testContext({ fetch }) });
    expect(fetch.remaining()).toBe(0);
    expect(r.template).toBe('buyer-guide');
    // The recorded first answer broke the template schema; exactly one repair call followed.
    expect(r.repaired).toBe(true);
    expect(r.rungs.map((x) => x.step)).toEqual(['extract', 'repair']);
    const repairBody = JSON.parse(String(fetch.calls.at(-1)?.body)) as { messages: { role: string; content: string }[] };
    expect(repairBody.messages.at(-1)?.content).toContain('does not match the schema');
    expect(repairBody.messages.at(-2)?.role).toBe('assistant');

    expect(r.citations.length).toBeGreaterThan(0);
    const byId = new Map(contexts.map((c) => [c.metadata.ref.id, c]));
    for (const c of r.citations) {
      expect(verifyQuote(byId.get(c.videoId) as VideoContext, c.quote, c.startSec).ok).toBe(true);
      expect(c.url).toMatch(/&t=\d+s$/);
    }
    // The model cited V1 for quotes spoken in other videos or at other times; those are removed, not shown.
    expect(r.unverified.length).toBeGreaterThan(0);
    expect(r.unverified.every((u) => u.reason !== undefined && u.path?.startsWith('/'))).toBe(true);
    // No citation object left in the data is unverified: the only quotes in it are the verified ones.
    const raw = JSON.stringify(r.data);
    expect(raw.match(/"quote"/g)?.length ?? 0).toBe(r.citations.length);
  });

  it('accepts a valid first answer for a custom schema without a repair call, and reports uncited values', async () => {
    const s = SCENARIOS['extract-repair'];
    const fetch = replayRecording(loadRecording('extract-repair'));
    const r = await extract(contextsFor(s.videos), { ...s.options, sleep: noWait }, { registry, ctx: testContext({ fetch }) });
    expect(fetch.remaining()).toBe(0);
    expect(fetch.calls.length).toBe(1);
    expect(r.repaired).toBe(false);
    expect(r.rungs.map((x) => x.step)).toEqual(['extract']);
    expect(r.template).toBeUndefined();
    // Citation paths point into the unwrapped data, and every value no verified citation covers is listed.
    for (const c of r.citations) expect(c.path.startsWith('/data')).toBe(false);
    const covered = (p: string) => r.citations.some((c) => p === c.path || p.startsWith(`${c.path}/`));
    expect(r.uncited?.every((p) => !covered(p))).toBe(true);
  });
});
