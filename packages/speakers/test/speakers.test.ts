import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clearCooldowns, createContext, Registry, stderrLogger, type VideoContext } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import { beforeEach, describe, expect, it } from 'vitest';
import { nameSpeakers, quoteAppearsNear } from '../src/index.ts';
import { CLIPS, loadContext, readJson } from './fixture-context.ts';
import type { RecordedLlmCall } from './record-fixtures.ts';

const registry = new Registry([llm].flat(), 'node');

interface LlmFixture {
  recordedAt: string;
  rung: string;
  calls: RecordedLlmCall[];
}

/** Replay the recorded answer of the rung that produced it, and run only that rung. */
function replay(name: string) {
  const fx = readJson<LlmFixture>(name);
  const ok = fx.calls.filter((c) => c.status === 200).at(-1);
  if (!ok) throw new Error(`${name} has no successful call`);
  const fetch = replayFetch([
    { method: 'POST', url: ok.url, response: { status: 200, headers: { 'content-type': ok.contentType }, body: ok.body } },
  ]);
  return { fetch, rung: fx.rung };
}

beforeEach(() => clearCooldowns());

describe('nameSpeakers on the recorded Nixon to Apollo 11 call', () => {
  it('names the speaker handed the floor as "mister president", with a verified quote (gpt-oss-120b)', async () => {
    const input = loadContext(CLIPS.call);
    const before = structuredClone(input);
    const { fetch, rung } = replay('llm-nixon-armstrong-call.json');
    const res = await nameSpeakers(input, registry, testContext({ fetch }), { chain: { only: [rung] } });

    expect(res.rung).toBe('llm/ovh/gpt-oss-120b');
    expect(res.mapping.map((m) => [m.label, m.name])).toEqual([
      ['Speaker 0', null], // Houston CAPCOM: a call sign, never named in the video
      ['Speaker 2', 'President Nixon'],
      ['Speaker 1', null], // Armstrong, but only ever called "sir": not enough
    ]);
    const nixon = res.mapping[1];
    expect(nixon?.confidence).toBeCloseTo(0.97);
    expect(nixon?.evidence).toHaveLength(1);
    expect(nixon?.evidence[0]?.startSec).toBe(54);
    expect(quoteAppearsNear(input.transcript.segments, nixon?.evidence[0]?.quote ?? '', 54)).toBe(true);

    // The copy carries the name; the input is untouched.
    const speakers = new Set(res.context.transcript.segments.map((s) => s.speaker));
    expect([...speakers]).toEqual(['Speaker 0', 'President Nixon', 'Speaker 1']);
    expect(input).toEqual(before);
    expect(res.context.transcript.segments[0]).not.toBe(input.transcript.segments[0]);

    // One request: structured JSON, transcript fenced as untrusted data.
    expect(fetch.calls).toHaveLength(1);
    const body = JSON.parse(String(fetch.calls[0]?.body)) as {
      model: string;
      temperature: number;
      response_format: { type: string };
      messages: { content: string }[];
    };
    expect(body.model).toBe('gpt-oss-120b');
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe('json_object');
    expect(body.messages[1]?.content).toContain('<untrusted_transcript>');
  });

  it('accepts the same answer from another keyless model (Llama 3.3 70B)', async () => {
    const { fetch, rung } = replay('llm-nixon-armstrong-call--ovh-Meta-Llama-3-3-70B-Instruct.json');
    const res = await nameSpeakers(loadContext(CLIPS.call), registry, testContext({ fetch }), { chain: { only: [rung] } });
    expect(res.mapping.map((m) => m.name)).toEqual([null, 'Richard Nixon', null]);
  });

  it('leaves a name unapplied below minConfidence but still reports the verified evidence', async () => {
    const { fetch, rung } = replay('llm-nixon-armstrong-call.json');
    const input = loadContext(CLIPS.call);
    const res = await nameSpeakers(input, registry, testContext({ fetch }), { chain: { only: [rung] }, minConfidence: 0.98 });
    expect(res.mapping[1]).toMatchObject({ label: 'Speaker 2', name: null, confidence: 0.97 });
    expect(res.mapping[1]?.evidence).toHaveLength(1);
    expect(res.context.transcript.segments.map((s) => s.speaker)).toEqual(input.transcript.segments.map((s) => s.speaker));
  });
});

describe('nameSpeakers on the single-speaker Apollo 11 clip', () => {
  it('keeps the label when the model finds no evidence in the transcript', async () => {
    const { fetch, rung } = replay('llm-apollo11-small-step.json');
    const res = await nameSpeakers(loadContext(CLIPS.smallStep), registry, testContext({ fetch }), {
      chain: { only: [rung] },
    });
    expect(res.mapping).toEqual([{ label: 'Speaker 0', name: null, confidence: 0, evidence: [] }]);
    expect(res.context.transcript.segments.every((s) => s.speaker === 'Speaker 0')).toBe(true);
  });
});

describe('nameSpeakers without a model call', () => {
  it('returns an empty mapping for a transcript with no speaker labels and makes no request', async () => {
    const path = fileURLToPath(new URL('../../../tests/fixtures/contexts/youtube-jNQXAC9IVRw.json', import.meta.url));
    const ctxJson = JSON.parse(readFileSync(path, 'utf8')) as VideoContext;
    const fetch = replayFetch([]);
    const res = await nameSpeakers(ctxJson, registry, testContext({ fetch }));
    expect(res.mapping).toEqual([]);
    expect(res.context).toEqual(ctxJson);
    expect(res.context).not.toBe(ctxJson);
    expect(fetch.calls).toHaveLength(0);
  });

  it('never falls back to a paid rung unless the caller allows it', async () => {
    const fetch = replayFetch([]);
    const env = { OPENAI_API_KEY: 'sk-not-a-real-key', VID2CONTEXT_KEYLESS: '0' };
    await expect(
      nameSpeakers(loadContext(CLIPS.call), registry, testContext({ fetch, env }), { chain: { only: ['openai'] } }),
    ).rejects.toMatchObject({ code: 'no-provider' });
    expect(fetch.calls).toHaveLength(0);

    // Allowed explicitly, the paid rung is tried (and the replay, having no recording for it, refuses the request).
    await expect(
      nameSpeakers(loadContext(CLIPS.call), registry, testContext({ fetch, env }), {
        chain: { only: ['openai'], allowPaid: true },
      }),
    ).rejects.toMatchObject({ code: 'all-rungs-failed' });
    expect(fetch.calls[0]?.url).toContain('api.openai.com');
  });

  it('stops before calling the model when the caller has aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { fetch, rung } = replay('llm-nixon-armstrong-call.json');
    await expect(
      nameSpeakers(loadContext(CLIPS.call), registry, testContext({ fetch, signal: ac.signal }), { chain: { only: [rung] } }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe.skipIf(!process.env.LIVE)('nameSpeakers live on keyless rungs', () => {
  it('names nobody without a verified quote', async () => {
    const ctx = createContext({ runtime: 'node', env: {}, log: stderrLogger('warn') });
    const input = loadContext(CLIPS.call);
    const res = await nameSpeakers(input, registry, ctx);
    expect(res.mapping.map((m) => m.label)).toEqual(['Speaker 0', 'Speaker 2', 'Speaker 1']);
    for (const m of res.mapping) {
      if (!m.name) continue;
      expect(m.evidence.length).toBeGreaterThan(0);
      for (const e of m.evidence) expect(quoteAppearsNear(input.transcript.segments, e.quote, e.startSec)).toBe(true);
    }
    expect(res.mapping[0]?.name ?? '').not.toMatch(/houston/i);
  }, 300_000);
});
