import { OFFLINE_PRODUCER } from '@vid2context/chapters';
import { Registry } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { loadChaptersDataset } from '../src/dataset.ts';
import { renderReport } from '../src/report.ts';
import { type EvalResult, summarize } from '../src/results.ts';
import { blind, loadChaptersContext, scoreOffline, UNIFORM_BASELINE, uniformStarts } from '../src/suites/chapters.ts';

const data = loadChaptersDataset();

describe('chapters dataset', () => {
  it('points every item at a recorded context holding the reference it names', () => {
    expect(data.items.length).toBeGreaterThanOrEqual(4);
    expect(data.items.some((i) => i.reference === 'creator-chapters')).toBe(true);
    for (const item of data.items) {
      const ctx = loadChaptersContext(item);
      expect(ctx.metadata.ref.url ?? item.url).toContain(ctx.metadata.ref.nativeId);
      expect(ctx.transcript.segments.length).toBeGreaterThan(20);
    }
  });

  it('rejects an item whose reference kind does not match the recorded chapter source', () => {
    const lex = data.items.find((i) => i.reference === 'creator-chapters');
    expect(lex).toBeDefined();
    if (!lex) return;
    expect(() => loadChaptersContext({ ...lex, reference: 'key-moments' })).toThrow(/not key-moments/);
  });
});

describe('blind', () => {
  it('hides the chapters and description but keeps the raw transcript', () => {
    const ctx = loadChaptersContext(data.items[0] as (typeof data.items)[number]);
    const b = blind(ctx);
    expect(b.metadata.chapters).toEqual([]);
    expect(b.metadata.description).toBeUndefined();
    expect(b.metadata.extra?.chapterSource).toBeUndefined();
    expect(b.transcript).toBe(ctx.transcript);
    expect(ctx.metadata.chapters?.length).toBe(20);
  });
});

describe('uniformStarts', () => {
  it('spaces n starts evenly from 0', () => {
    expect(uniformStarts(4, 1834)).toEqual([0, 458.5, 917, 1375.5]);
    expect(uniformStarts(0, 100)).toEqual([0]);
  });
});

describe('offline scoring on the recorded contexts', async () => {
  // Offline scoring never consults the registry: no LLM rung is asked.
  const registry = new Registry([], 'node');
  const rows = (
    await Promise.all(
      data.items.map((item) => scoreOffline(registry, item, loadChaptersContext(item), data.toleranceSec, testContext())),
    )
  ).flat();

  it('scores both offline producers on every item, with counts that add up', () => {
    expect(rows).toHaveLength(data.items.length * 2);
    for (const r of rows) {
      const c = r.chapters;
      expect(r.outcome).toBe('ok');
      expect(c).toBeDefined();
      if (!c) continue;
      expect(c.starts[0]).toBe(0);
      expect(c.matched).toBeLessThanOrEqual(Math.min(c.predicted, c.reference));
      expect(c.toleranceSec).toBe(30);
    }
    const lex = rows.find((r) => r.item === 'lex-118-grant-sanderson' && r.rung === OFFLINE_PRODUCER);
    // 19 creator boundaries after 0; the rules allow 17 to 43 chapters for 2 h 8 min.
    expect(lex?.chapters?.reference).toBe(19);
    expect(lex?.chapters?.predicted).toBeGreaterThanOrEqual(16);
  });

  it('is deterministic', async () => {
    const item = data.items[2] as (typeof data.items)[number];
    const again = await scoreOffline(registry, item, loadChaptersContext(item), data.toleranceSec, testContext());
    expect(again.map((r) => r.chapters?.starts)).toEqual(rows.filter((r) => r.item === item.id).map((r) => r.chapters?.starts));
  });

  it('summarizes pooled boundary scores per producer, split by reference kind, and renders a report', () => {
    const summary = summarize(rows);
    expect(summary.map((s) => s.rung)).toEqual([UNIFORM_BASELINE, OFFLINE_PRODUCER]);
    for (const s of summary) {
      expect(s.boundaryF1).toBeGreaterThanOrEqual(0);
      expect(s.boundaryF1).toBeLessThanOrEqual(1);
      expect(s.boundaryF1Creator).toBeDefined();
      expect(s.boundaryF1KeyMoments).toBeDefined();
      expect(s.toleranceSec).toBe(30);
    }
    const result: EvalResult = {
      suite: 'chapters',
      date: '2026-11-15',
      startedAt: '2026-11-15T00:00:00.000Z',
      finishedAt: '2026-11-15T00:00:01.000Z',
      dataset: { file: 'packages/evals/datasets/chapters.json', items: data.items.length, evaluated: data.items.length },
      environment: {
        node: 'v22',
        platform: 'linux-x64',
        policy: 'free',
        keyless: true,
        rungs: [UNIFORM_BASELINE, OFFLINE_PRODUCER],
        envFiles: 0,
      },
      skippedRungs: [],
      notes: [],
      items: rows,
    };
    const md = renderReport(result);
    expect(md).toContain('| Producer | Items | OK | Tolerance | Boundary precision |');
    expect(md).toContain(`| ${OFFLINE_PRODUCER} | 4 | 4 | 30 s |`);
    expect(md).toContain('| lex-118-grant-sanderson | creator-chapters | chapters/texttiling | ok |');
  });
});
