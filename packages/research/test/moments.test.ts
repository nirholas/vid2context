import { clearCooldowns } from '@vid2context/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chunkBudget,
  chunkLines,
  compactLines,
  keyMoments,
  MAX_CHUNK_TOKENS,
  momentsRequest,
  parseMoments,
  renderKeyMoments,
  SNAP_SEC,
  validateMoments,
} from '../src/moments.ts';
import {
  ctxWith,
  filledStorage,
  GWAGON,
  type LlmFixture,
  llmRoute,
  loadContext,
  loadLlmFixture,
  makeRegistry,
} from './helpers.ts';

// Real keyless chain answers for this package's exact prompt (see test/fixtures/README.md).
const single = loadLlmFixture('key-moments-cCPsdFdlshc.json');
const chunked = loadLlmFixture('key-moments-cCPsdFdlshc-chunked.json');
const gwagon = loadContext('cCPsdFdlshc');
const starts = new Set(gwagon.transcript.segments.map((s) => s.startSec));

/** The moments the model proposed in the answered (status 200) calls, as recorded. */
function proposals(f: LlmFixture) {
  return f.calls
    .filter((c) => c.status === 200)
    .flatMap((c) => {
      const text = (JSON.parse(c.response) as { choices: { message: { content: string } }[] }).choices[0]?.message.content ?? '';
      return parseMoments(text) ?? [];
    });
}

async function run(f: LlmFixture) {
  const deps = { registry: makeRegistry(), ctx: ctxWith([llmRoute(f)]), storage: await filledStorage() };
  return keyMoments(GWAGON, { count: f.options.count, chunkTokens: f.options.chunkTokens }, deps);
}

beforeEach(() => clearCooldowns());

describe('transcript compaction', () => {
  it('merges real segments into ~10 s lines tagged with whole seconds', () => {
    const lines = compactLines(gwagon.transcript.segments);
    expect(lines[0]?.startSec).toBe(0);
    expect(lines[0]?.text.startsWith("so you're going to buy G wagon")).toBe(true);
    for (let i = 1; i < lines.length; i++)
      expect((lines[i]?.startSec ?? 0) - (lines[i - 1]?.startSec ?? 0)).toBeGreaterThanOrEqual(9);
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    expect(lines.reduce((n, l) => n + words(l.text), 0)).toBe(gwagon.transcript.segments.reduce((n, s) => n + words(s.text), 0));
  });

  it('chunks to a token budget without losing a line', () => {
    const lines = compactLines(gwagon.transcript.segments);
    const chunks = chunkLines(lines, 2000);
    expect(chunks.length).toBe(3);
    expect(chunks.flat()).toEqual(lines);
    expect(chunkLines(lines, 100_000)).toHaveLength(1);
  });

  it('sizes chunks from the smallest context window the chain may try', () => {
    const registry = makeRegistry();
    expect(chunkBudget({ registry, ctx: ctxWith([]) }, {})).toBe(MAX_CHUNK_TOKENS);
    // A model id the lane does not know declares no window, so the budget falls to the conservative default.
    const unknown = chunkBudget({ registry, ctx: ctxWith([], { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-next-preview' }) }, {});
    expect(unknown).toBe(Math.floor((8192 - 3000 - 600) * 0.85));
  });
});

describe('keyMoments on the recorded keyless answer', () => {
  it('was recorded with this exact prompt', () => {
    const lines = compactLines(gwagon.transcript.segments);
    const req = momentsRequest(gwagon, lines, { index: 0, total: 1, count: 8 });
    for (const c of single.calls) {
      // The provider appends its JSON-format instruction to the system message; the rest is ours, byte for byte.
      expect(c.request.messages[0]?.content.startsWith(req.messages[0]?.content ?? '-')).toBe(true);
      expect(c.request.messages[1]).toEqual(req.messages[1]);
    }
  });

  it('snaps every timestamp to a real segment start and reports the rung', async () => {
    const r = await run(single);
    expect(r.rung).toBe(single.rung);
    expect(r.rungs).toEqual([single.rung]);
    expect(r.chunks).toBe(1);
    expect(r.requested).toBe(8);
    expect(r.proposed).toBe(proposals(single).length);
    expect(r.moments.length + r.dropped).toBeGreaterThanOrEqual(Math.min(8, r.proposed));
    for (const m of r.moments) {
      expect(starts.has(m.startSec)).toBe(true);
      expect(m.url).toBe(`https://www.youtube.com/watch?v=cCPsdFdlshc&t=${Math.floor(m.startSec)}s`);
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.why.length).toBeGreaterThan(0);
    }
    for (let i = 1; i < r.moments.length; i++)
      expect(r.moments[i]?.startSec ?? 0).toBeGreaterThan(r.moments[i - 1]?.startSec ?? 0);
    // Every rung tried is in attempts, the answering one last and ok.
    expect(r.attempts.at(-1)).toMatchObject({ id: single.rung, stage: 'llm', outcome: 'ok' });
    for (const c of single.calls.filter((x) => x.status === 429)) {
      expect(r.attempts).toContainEqual(expect.objectContaining({ stage: 'llm', outcome: 'error', reason: 'rate-limited-429' }));
      expect(r.attempts.some((a) => a.id.endsWith(c.model))).toBe(true);
    }
    expect(renderKeyMoments(r)).toContain(`chosen by ${single.rung}`);
  });

  it('keeps proposals within 5 s of a segment start and drops the rest, counting them', () => {
    const raw = proposals(single);
    const ok = validateMoments(raw, gwagon);
    expect(ok.dropped).toEqual([]);
    for (const [i, m] of ok.moments.entries()) {
      expect(Math.abs(m.startSec - Number(raw[i]?.startSec))).toBeLessThanOrEqual(SNAP_SEC);
    }
    // The same real proposals moved into a silent stretch past the end of the video: none can be verified.
    const end = gwagon.transcript.segments.at(-1)?.startSec ?? 0;
    const late = validateMoments(
      raw.map((m) => ({ ...m, startSec: end + SNAP_SEC + 1 })),
      gwagon,
    );
    expect(late.moments).toEqual([]);
    expect(late.dropped.every((d) => d.reason === 'no-segment-within-5s')).toBe(true);
    // Repeating a proposal yields one moment and one duplicate.
    const twice = validateMoments([raw[0] ?? {}, raw[0] ?? {}], gwagon);
    expect(twice.moments).toHaveLength(1);
    expect(twice.dropped.map((d) => d.reason)).toEqual(['duplicate']);
  });

  it('merges chunked answers into the requested count, in video order', async () => {
    const r = await run(chunked);
    expect(r.chunks).toBe(3);
    expect(r.moments.length).toBeLessThanOrEqual(chunked.options.count);
    expect(r.moments.length).toBeGreaterThan(0);
    for (const m of r.moments) expect(starts.has(m.startSec)).toBe(true);
    // Moments come from across the video, not only the first chunk.
    expect(r.moments.at(-1)?.startSec ?? 0).toBeGreaterThan((gwagon.transcript.segments.at(-1)?.startSec ?? 0) / 2);
    expect(r.proposed).toBe(proposals(chunked).length);
    if (r.dropped > 0) expect(r.notes[0]).toMatch(/^Dropped \d+ of \d+ proposed moments/);
  });

  it('rejects a count out of range', async () => {
    const deps = { registry: makeRegistry(), ctx: ctxWith([]), storage: await filledStorage() };
    await expect(keyMoments(GWAGON, { count: 0 }, deps)).rejects.toMatchObject({ code: 'bad-request' });
    await expect(keyMoments(GWAGON, { count: 31 }, deps)).rejects.toMatchObject({ code: 'bad-request' });
  });
});
