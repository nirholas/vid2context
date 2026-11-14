/**
 * The engine on recorded keyless LLM responses (see fixtures/README.md).
 * Inputs resolve through getVideoContext against a MemoryStorage that holds
 * the shared contexts, so no request reaches YouTube.
 */
import { clearCooldowns } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ask, askStream } from '../src/engine.ts';
import type { AskEvent } from '../src/types.ts';
import { GWAGON_URL, loadRecording, makeRegistry, makeStorage, modelOf, replayRecording } from './helpers.ts';

const registry = makeRegistry();

beforeEach(() => clearCooldowns());

describe('ask', () => {
  it('answers with numbered sources, timestamp URLs and only existing [n]', async () => {
    const fetch = replayRecording(loadRecording('gwagon-g55'));
    const { storage } = await makeStorage();
    const r = await ask(
      registry,
      {
        question: 'How much horsepower does the G55 AMG compressor engine make, and does it have any known issues?',
        inputs: [GWAGON_URL],
        storage,
      },
      testContext({ fetch }),
    );
    expect(r.sources.map((s) => s.n)).toEqual(r.sources.map((_, i) => i + 1));
    for (const s of r.sources) expect(s.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=cCPsdFdlshc&t=\d+s$/);
    const cited = [...r.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    expect(cited.length).toBeGreaterThan(0);
    for (const n of cited) expect(r.sources.some((s) => s.n === n)).toBe(true);
    expect(r.answer).toMatch(/49[01]/);
    expect(r.citations.length).toBeGreaterThan(0);
    for (const c of r.citations) {
      expect(c.url).toBe(`https://www.youtube.com/watch?v=cCPsdFdlshc&t=${Math.floor(c.startSec)}s`);
      expect(c.quote?.length).toBeGreaterThan(0);
    }
    expect(r.rung).toMatch(/^llm\//);
    expect(r.attempts.at(-1)?.outcome).toBe('ok');
  });

  it('says plainly when the sources do not cover the question', async () => {
    const fetch = replayRecording(loadRecording('gwagon-offtopic'));
    const { storage } = await makeStorage();
    const r = await ask(
      registry,
      { question: 'What is the towing capacity of the electric G580?', inputs: [GWAGON_URL], storage },
      testContext({ fetch }),
    );
    expect(r.answer.toLowerCase()).toMatch(/not|no information|does not|doesn't/);
    expect(r.unverified).toEqual([]);
  });

  it('condenses a follow-up into a standalone query, then answers with the history', async () => {
    const rec = loadRecording('gwagon-followup');
    const fetch = replayRecording(rec);
    const { storage } = await makeStorage();
    const r = await ask(
      registry,
      {
        question: 'How much power does it make?',
        history: [
          { role: 'user', content: 'Which engine does the 2000 G500 use?' },
          { role: 'assistant', content: 'It uses the M113 V8 [2].' },
        ],
        inputs: [GWAGON_URL],
        storage,
        maxSourceTokens: 1200,
      },
      testContext({ fetch }),
    );
    const bodies = fetch.calls.map((c) => JSON.parse(String(c.body)) as { messages: { role: string; content: string }[] });
    const condense = bodies[0];
    expect(condense?.messages[0]?.content).toContain('standalone search query');
    const answer = bodies.at(-1);
    expect(answer?.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(answer?.messages[2]?.content).toBe('It uses the M113 V8.');
    expect(r.answer).toMatch(/300/);
    expect(r.sources.some((s) => s.text.includes('300 horsepower'))).toBe(true);
  });

  it('retrieves across a collection in chunked mode and cites the right video', async () => {
    const fetch = replayRecording(loadRecording('collection-na-offroad'));
    const { storage, collection } = await makeStorage();
    const r = await ask(
      registry,
      {
        question: 'Why did they pick a naturally aspirated G550 for an off-road build instead of a biturbo?',
        collectionId: collection.id,
        storage,
        maxSourceTokens: 1500,
      },
      testContext({ fetch }),
    );
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.map((s) => s.text).join(' ')).toMatch(/coolers/);
    for (const c of r.citations) expect(c.videoId).toBe('youtube:cCPsdFdlshc');
  });
});

describe('model choice', () => {
  const pinned = 'llm/ovh/Meta-Llama-3_3-70B-Instruct';

  it('strict pins exactly one rung and fails on its recorded 429', async () => {
    const fetch = replayRecording(loadRecording('strict-429'));
    const { storage } = await makeStorage();
    const events: AskEvent[] = [];
    for await (const ev of askStream(
      registry,
      {
        question: 'What does the 2000 G500 interior look like?',
        inputs: [GWAGON_URL],
        storage,
        model: { rung: pinned, strict: true },
      },
      testContext({ fetch }),
    )) {
      events.push(ev);
    }
    expect(fetch.calls).toHaveLength(1);
    expect(modelOf(fetch.calls[0] as never)).toBe('Meta-Llama-3_3-70B-Instruct');
    expect(events.map((e) => e.type)).toEqual(['error']);
    const err = events[0] as Extract<AskEvent, { type: 'error' }>;
    expect(err.code).toBe('all-rungs-failed');
    expect(err.attempts?.map((a) => a.reason)).toEqual(['rate-limited-429']);
  });

  it('non-strict falls back along the chain after the recorded 429', async () => {
    const fetch = replayRecording(loadRecording('strict-429'));
    const { storage } = await makeStorage();
    const r = await ask(
      registry,
      { question: 'What does the 2000 G500 interior look like?', inputs: [GWAGON_URL], storage, model: { rung: pinned } },
      testContext({ fetch }),
    );
    expect(modelOf(fetch.calls[0] as never)).toBe('Meta-Llama-3_3-70B-Instruct');
    expect(fetch.calls.length).toBeGreaterThan(1);
    expect(r.rung).not.toBe(pinned);
    expect(r.attempts[0]).toMatchObject({ id: pinned, outcome: 'error', reason: 'rate-limited-429' });
  });
});
