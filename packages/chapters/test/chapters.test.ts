import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearCooldowns, getVideoContext, Registry, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { type RecordedCall, replayFetch, testContext } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import { youtubeCaptions, youtubeSource } from '@vid2context/provider-youtube';
import { fixtureRoutes, readRecorded } from '@vid2context/testkit/recorder';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { chaptersRoutes } from '../src/http.ts';
import {
  autoChapters,
  checkChapters,
  countRange,
  OFFLINE_PRODUCER,
  refineRequest,
  textTiling,
  withAutoChapters,
} from '../src/index.ts';
import { promptBudget } from '../src/llm.ts';

// Real data only: shared VideoContext fixtures, YouTube responses recorded by
// the youtube provider, and LLM answers recorded by scripts/record.ts.
const root = join(import.meta.dirname, '..', '..', '..');
const fixtures = join(import.meta.dirname, 'fixtures');
const loadContext = (id: string): VideoContext =>
  JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'contexts', `youtube-${id}.json`), 'utf8')) as VideoContext;
const gwagon = loadContext('cCPsdFdlshc');
const zoo = loadContext('jNQXAC9IVRw');

const llmRegistry = new Registry([llm], 'node');

function assertValid(
  chapters: { title: string; startSec: number; endSec?: number }[],
  context: VideoContext,
  durationSec: number,
) {
  expect(checkChapters(chapters, durationSec)).toEqual([]);
  expect(chapters[0]?.startSec).toBe(0);
  const starts = new Set(context.transcript.segments.map((s) => s.startSec));
  for (const [i, c] of chapters.entries()) {
    if (i > 0) expect(starts.has(c.startSec)).toBe(true);
    expect(c.endSec).toBe(chapters[i + 1]?.startSec ?? durationSec);
    expect(c.title).not.toMatch(/[\u2013\u2014]/);
  }
}

beforeEach(() => clearCooldowns());

describe('offline TextTiling', () => {
  it('gives valid chapters for the 18 minute G-Wagon video, snapped to real segment starts', async () => {
    const res = await autoChapters(llmRegistry, gwagon, { llm: false }, testContext());
    const duration = gwagon.metadata.durationSec ?? 0;
    expect(res.producer).toBe(OFFLINE_PRODUCER);
    expect(res.source).toBe('auto');
    expect(res.method).toBe('texttiling');
    expect(res.durationSec).toBe(duration);
    assertValid(res.chapters, gwagon, duration);
    const { min, max } = countRange(duration);
    expect(res.chapters.length).toBeGreaterThanOrEqual(min);
    expect(res.chapters.length).toBeLessThanOrEqual(max);
    expect(res.chapters.at(-1)?.endSec).toBe(duration);
    for (const c of res.chapters) expect(c.title.length).toBeGreaterThan(0);
  });

  it('is stable: the same transcript gives the same chapters', async () => {
    const a = await autoChapters(llmRegistry, gwagon, { llm: false }, testContext());
    const b = await autoChapters(llmRegistry, structuredClone(gwagon), { llm: false }, testContext());
    expect(b.chapters).toEqual(a.chapters);
  });

  it('scales the count with the target length and keeps every rule', () => {
    const duration = gwagon.metadata.durationSec ?? 0;
    for (const targetSec of [180, 300, 480]) {
      const r = textTiling(gwagon.transcript.segments, { durationSec: duration, language: 'en', targetSec });
      const chapters = r.starts.map((startSec) => ({ title: 't', startSec }));
      expect(checkChapters(chapters, duration)).toEqual([]);
      expect(r.starts.length).toBeLessThanOrEqual(r.target);
    }
    const few = textTiling(gwagon.transcript.segments, { durationSec: duration, targetSec: 480 }).starts.length;
    const many = textTiling(gwagon.transcript.segments, { durationSec: duration, targetSec: 180 }).starts.length;
    expect(many).toBeGreaterThanOrEqual(few);
  });

  it('never touches the raw transcript or metadata', async () => {
    const before = structuredClone(gwagon);
    const res = await autoChapters(llmRegistry, gwagon, { llm: false }, testContext());
    expect(gwagon).toEqual(before);
    const stored = withAutoChapters(gwagon, res);
    expect(stored.metadata.extra?.chapterSource).toBe('auto');
    expect(stored.metadata.chapters).toHaveLength(res.chapters.length);
    expect(stored.transcript).toBe(gwagon.transcript);
    expect(gwagon.metadata.chapters).toEqual([]);
  });
});

describe('validation', () => {
  it('rejects the real 3 description chapters of a 19 second video (too short each)', () => {
    const problems = checkChapters(zoo.metadata.chapters, zoo.metadata.durationSec ?? 19);
    expect(problems.some((p) => p.includes('expected 1 to 1'))).toBe(true);
    expect(problems.some((p) => p.includes('under the 60 s minimum'))).toBe(true);
  });

  it('catches a first chapter after 0, unordered starts and empty titles', () => {
    expect(checkChapters([{ title: 'a', startSec: 5 }], 600)[0]).toContain('not 0');
    const p = checkChapters(
      [
        { title: 'a', startSec: 0 },
        { title: '', startSec: 300 },
        { title: 'c', startSec: 200 },
      ],
      900,
    );
    expect(p.join(' ')).toContain('Chapter 2 has no usable title');
    expect(p.join(' ')).toContain('does not start after');
  });

  it('only runs on videos without chapters unless forced', async () => {
    await expect(autoChapters(llmRegistry, zoo, { llm: false }, testContext())).rejects.toMatchObject({ code: 'bad-request' });
    const forced = await autoChapters(llmRegistry, zoo, { llm: false, force: true }, testContext());
    expect(forced.chapters).toHaveLength(1);
    expect(forced.chapters[0]).toMatchObject({ startSec: 0, endSec: zoo.metadata.durationSec });
  });
});

describe('LLM titling (recorded keyless answers)', () => {
  it('builds the same prompt the fixture was recorded with', () => {
    const recorded = readRecorded(fixtures, { name: 'llm-titles' }).at(-1)?.exchange;
    const body = JSON.parse(recorded?.request.body ?? '{}') as { messages: { content: string }[] };
    const tiling = textTiling(gwagon.transcript.segments, { durationSec: 1084, language: 'en' });
    const ctx = testContext();
    const req = refineRequest({
      context: gwagon,
      starts: tiling.starts,
      durationSec: 1084,
      windowSec: 45,
      summaries: false,
      budget: promptBudget(llmRegistry, { only: ['ovh'] }, ctx),
    });
    const unfence = (s: string) => s.replace(/[0-9a-f]{24}/g, 'B');
    expect(unfence(body.messages.at(-1)?.content ?? '')).toBe(unfence(req.messages.at(-1)?.content ?? ''));
  });

  it('titles and refines the offline boundaries, falling through a rate-limited rung', async () => {
    const fetch = replayFetch(fixtureRoutes(fixtures, { name: 'llm-titles' }));
    const res = await autoChapters(llmRegistry, gwagon, { chain: { only: ['ovh'] } }, testContext({ fetch }));
    expect(fetch.calls).toHaveLength(2);
    expect(res.method).toBe('texttiling+llm');
    expect(res.producer).toBe('llm/ovh/gpt-oss-120b');
    expect(res.rung).toBe(res.producer);
    expect(res.attempts.map((a) => a.reason ?? a.outcome)).toEqual(['rate-limited-429', 'ok']);
    assertValid(res.chapters, gwagon, 1084);
    expect(res.chapters.map((c) => c.title)).toEqual([
      'Intro and 2000 G500 Engine/Interior',
      'G55 AMG Overview: Engine, Interior, and Tech',
      '2015 G550: New V8, 7-Speed, Interior',
      '4.0L Turbo Era: Performance and Buyer Advice',
    ]);
    const offline = await autoChapters(llmRegistry, gwagon, { llm: false }, testContext());
    for (const [i, c] of res.chapters.entries()) {
      expect(Math.abs(c.startSec - (offline.chapters[i]?.startSec ?? 0))).toBeLessThanOrEqual(45);
    }
  });

  it('adds one or two sentence summaries when asked', async () => {
    const fetch = replayFetch(fixtureRoutes(fixtures, { name: 'llm-summaries' }));
    const res = await autoChapters(
      llmRegistry,
      gwagon,
      { summaries: true, chain: { only: ['pollinations'] } },
      testContext({ fetch }),
    );
    expect(res.producer).toBe('llm/pollinations/openai-fast');
    assertValid(res.chapters, gwagon, 1084);
    for (const c of res.chapters) {
      expect(c.summary?.length ?? 0).toBeGreaterThan(40);
      expect(c.summary).not.toMatch(/[\u2013\u2014\u2026]/);
    }
  });

  it('falls back to offline titles when every rung fails', async () => {
    const fetch = replayFetch(fixtureRoutes(fixtures, { name: 'llm-titles' }));
    const res = await autoChapters(
      llmRegistry,
      gwagon,
      { chain: { only: ['llm/ovh/Meta-Llama-3_3-70B-Instruct'] } },
      testContext({ fetch }),
    );
    expect(fetch.calls).toHaveLength(1);
    expect(res.method).toBe('texttiling');
    expect(res.producer).toBe(OFFLINE_PRODUCER);
    expect(res.notes[0]).toContain('most distinctive terms');
    expect(res.attempts[0]).toMatchObject({ outcome: 'error', reason: 'rate-limited-429' });
    assertValid(res.chapters, gwagon, 1084);
  });

  it('falls back when the answer does not fit the sections (4 recorded chapters for 3 sections)', async () => {
    const fetch = replayFetch(fixtureRoutes(fixtures, { name: 'llm-summaries' }));
    const res = await autoChapters(
      llmRegistry,
      gwagon,
      { targetSec: 360, chain: { only: ['pollinations'] } },
      testContext({ fetch }),
    );
    expect(res.chapters).toHaveLength(3);
    expect(res.method).toBe('texttiling');
    expect(res.attempts.at(-1)).toMatchObject({ reason: 'invalid-chapters' });
    expect(res.notes[0]).toContain('4 chapters for 3 sections');
  });
});

describe('POST /chapters', () => {
  const yt = (name: string) => readFileSync(join(root, 'providers', 'youtube', 'test', 'fixtures', name), 'utf8');
  const registry = new Registry([youtubeSource, youtubeCaptions, llm], 'node');

  function app(fetch: typeof globalThis.fetch) {
    const main = new Hono();
    main.route('/api/v1', chaptersRoutes({ registry, makeCtx: () => testContext({ fetch }), storage: async () => null }));
    main.onError((err, c) =>
      err instanceof Vid2ContextError
        ? c.json({ error: { code: err.code, hint: err.hint } }, 400)
        : c.json({ error: 'internal' }, 500),
    );
    return main;
  }

  function youtubeRoutes() {
    return [
      {
        method: 'POST',
        url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        response: (call: RecordedCall) => {
          const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
          return { body: yt(`player-${videoId}.json`), headers: { 'content-type': 'application/json' } };
        },
      },
      { url: /timedtext\?v=cCPsdFdlshc.*lang=en.*fmt=srv3/, response: { body: yt('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
    ];
  }

  it('returns valid auto chapters for a video without chapters', async () => {
    const fetch = replayFetch([...youtubeRoutes(), ...fixtureRoutes(fixtures, { name: 'llm-titles' })]);
    const res = await app(fetch).request('/api/v1/chapters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=cCPsdFdlshc' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chapters: { title: string; startSec: number; endSec: number }[];
      producer: string;
      rung: string;
    };
    expect(body.producer).toBe(body.rung);
    expect(body.rung).toMatch(/^llm\/ovh\//);
    expect(checkChapters(body.chapters, 1084)).toEqual([]);
  });

  it('answers bad-request for a missing url and for a video that has chapters', async () => {
    const fetch = replayFetch(youtubeRoutes());
    const missing = await app(fetch).request('/api/v1/chapters', { method: 'POST', body: '{}' });
    expect(await missing.json()).toMatchObject({ error: { code: 'bad-request' } });
    const zooRes = await app(
      replayFetch([
        ...youtubeRoutes(),
        { url: /timedtext\?v=jNQXAC9IVRw/, response: { body: yt('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
      ]),
    ).request('/api/v1/chapters', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }),
    });
    const body = (await zooRes.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('bad-request');
    expect(body.error.hint).toContain('force');
  });
});

describe.skipIf(!process.env.LIVE)('live', () => {
  it('auto-chapters a real video without chapters', async () => {
    const { createNodeContext, createRegistry } = await import('@vid2context/registry/node');
    const ctx = createNodeContext();
    const live = createRegistry();
    const context = await getVideoContext(live, 'https://www.youtube.com/watch?v=cCPsdFdlshc', { mode: 'captions' }, ctx);
    const res = await autoChapters(live, context, {}, ctx);
    expect(checkChapters(res.chapters, res.durationSec)).toEqual([]);
    console.error(res.producer, JSON.stringify(res.chapters, null, 2));
  });

  it('titles the chapters of a real transcript with the live LLM chain (no YouTube call)', async () => {
    const { createNodeContext, createRegistry } = await import('@vid2context/registry/node');
    const ctx = createNodeContext();
    const res = await autoChapters(createRegistry(), gwagon, { summaries: true }, ctx);
    expect(checkChapters(res.chapters, res.durationSec)).toEqual([]);
    console.error(res.producer, res.notes, JSON.stringify(res.chapters, null, 2));
  });
});
