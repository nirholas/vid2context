import { readFileSync } from 'node:fs';
import { type Env, rankRungs, runChain, Vid2ContextError } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { deepgramQuery, parseDeepgram, REST_BASE_URL, sttRungs, transcribe } from '../src/index.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const apollo = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url)));
const audio = { kind: 'bytes' as const, data: apollo, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' };

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const REST_ENV: Env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'cf-test-token' };
const MODEL = '@cf/deepgram/nova-3';
const RUN_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`;
const ID = `stt/cloudflare/${MODEL}`;

function nova3(env: Env = REST_ENV) {
  const r = sttRungs(env).find((x) => x.id === ID);
  if (!r) throw new Error(`no rung ${ID}`);
  return r;
}

describe('Deepgram nova-3 rung', () => {
  it('is a REST-only free rung with the diarization capability, after every Whisper rung', () => {
    const rungs = sttRungs({ ...REST_ENV, CLOUDFLARE_AI_BINDING: 'AI' });
    const r = nova3();
    expect(r.capabilities).toEqual(['segments', 'language-detect', 'diarization']);
    expect(r.tier).toBe('free');
    expect(r.requires).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
    expect(r.isEnabled?.(REST_ENV)).toBe(true);
    expect(nova3({}).isEnabled?.({})).toBe(false);
    expect(rungs.some((x) => x.service === 'cloudflare-binding' && x.model === MODEL)).toBe(false);
    const whisper = rungs.filter((x) => x.service === 'cloudflare' && x.model !== MODEL);
    for (const w of whisper) expect(w.priority).toBeLessThan(r.priority);
    expect(rungs.filter((x) => x.capabilities.includes('diarization')).map((x) => x.id)).toEqual([ID]);
  });

  it('takes the model list from CLOUDFLARE_DIARIZE_MODEL and never duplicates a model listed for plain STT', () => {
    expect(sttRungs({ CLOUDFLARE_DIARIZE_MODEL: '' }).filter((r) => r.model === MODEL)).toHaveLength(1);
    const env = { ...REST_ENV, CLOUDFLARE_STT_MODEL: `${MODEL},@cf/openai/whisper-large-v3-turbo` };
    const ids = sttRungs(env).map((r) => r.id);
    expect(ids.filter((id) => id === ID)).toHaveLength(1);
    expect(ids).not.toContain(`stt/cloudflare-binding/${MODEL}`);
    expect(sttRungs({ CLOUDFLARE_DIARIZE_MODEL: '@cf/deepgram/nova-3, @cf/deepgram/flux' }).map((r) => r.model)).toContain(
      '@cf/deepgram/flux',
    );
  });

  it('asks for speaker labels only when diarizing, and detects the language unless given', () => {
    expect(deepgramQuery({ diarize: true })).toEqual({
      diarize: 'true',
      smart_format: 'true',
      punctuate: 'true',
      utterances: 'true',
      paragraphs: 'true',
      detect_language: 'true',
    });
    const plain = deepgramQuery({ language: 'en-US' });
    expect(plain.diarize).toBe('false');
    expect(plain.language).toBe('en');
    expect(plain.detect_language).toBeUndefined();
  });
});

describe('Deepgram nova-3 over REST (recorded)', () => {
  it('sends the raw mp3 with the flags in the query and maps a three-speaker call', async () => {
    const fetch = replayFetch([
      { method: 'POST', url: (u) => u.href.startsWith(RUN_URL), response: { body: fixture('nova-3.nixon-call.diarize.json') } },
    ]);
    const res = await nova3().transcribe(audio, { diarize: true }, testContext({ env: REST_ENV, fetch }));
    const call = fetch.calls[0];
    const url = new URL(call?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(RUN_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual(deepgramQuery({ diarize: true }));
    expect(call?.headers.authorization).toBe('Bearer cf-test-token');
    expect(call?.headers['content-type']).toBe('audio/mpeg');
    expect((call?.body as Uint8Array | undefined)?.byteLength).toBe(apollo.byteLength);

    expect(res.model).toBe(MODEL);
    expect(res.language).toBe('en');
    expect(res.segments).toHaveLength(28);
    expect([...new Set(res.segments.map((s) => s.speaker))].sort()).toEqual(['Speaker 0', 'Speaker 1', 'Speaker 2']);
    const nixon = res.segments.find((s) => /Hello, Neil and Buzz/.test(s.text));
    expect(nixon?.speaker).toBe('Speaker 2');
    expect(nixon?.startSec).toBeCloseTo(54, 0);
    for (const s of res.segments) {
      expect(s.endSec).toBeGreaterThanOrEqual(s.startSec);
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('maps the single-speaker Apollo clip to Speaker 0', async () => {
    const fetch = replayFetch([
      { method: 'POST', url: (u) => u.href.startsWith(RUN_URL), response: { body: fixture('nova-3.apollo.diarize.json') } },
    ]);
    const res = await nova3().transcribe(audio, { diarize: true }, testContext({ env: REST_ENV, fetch }));
    expect(res.segments.map((s) => s.speaker)).toEqual(['Speaker 0', 'Speaker 0', 'Speaker 0', 'Speaker 0']);
    expect(res.segments[0]).toMatchObject({ startSec: 4.48, endSec: 6.4, text: "I'm gonna step off the land now." });
  });

  it('leaves speakers off when diarization was not asked for', () => {
    const out = (JSON.parse(fixture('nova-3.nixon-call.diarize.json')) as { result: Parameters<typeof parseDeepgram>[0] }).result;
    const { segments } = parseDeepgram(out, false);
    expect(segments).toHaveLength(28);
    expect(segments.every((s) => s.speaker === undefined)).toBe(true);
  });

  it('falls back to paragraph sentences when there are no utterances', () => {
    const out = (JSON.parse(fixture('nova-3.apollo.diarize.json')) as { result: Parameters<typeof parseDeepgram>[0] }).result;
    const { segments, language } = parseDeepgram({ results: { channels: out.results?.channels } }, true);
    expect(language).toBe('en');
    expect(segments.map((s) => s.text)).toEqual([
      "I'm gonna step off the land now.",
      "That's one small step per van.",
      'One biathlete per van.',
    ]);
    expect(segments.every((s) => s.speaker === 'Speaker 0')).toBe(true);
  });

  it('maps a rejected token to auth', async () => {
    const fetch = replayFetch([
      {
        method: 'POST',
        url: (u) => u.href.startsWith(RUN_URL),
        response: { status: 401, body: fixture('error-bad-token.json') },
      },
    ]);
    const err = await nova3()
      .transcribe(audio, { diarize: true }, testContext({ env: REST_ENV, fetch }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('auth');
  });

  it('refuses the binding transport instead of sending an unverified input', async () => {
    const err = await transcribe({ kind: 'binding', binding: 'AI' }, MODEL, audio, { diarize: true }, testContext(), 'x').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('bad-request');
    expect(REST_BASE_URL).toBe('https://api.cloudflare.com/client/v4');
  });
});

describe('routing with the diarization capability', () => {
  it('ranks nova-3 last for plain transcription and alone when diarization is required', async () => {
    const env = { ...REST_ENV, CLOUDFLARE_AI_BINDING: 'AI' };
    const rungs = sttRungs(env);
    expect(rankRungs(rungs, {}, env).at(-1)?.id).toBe(ID);
    const fetch = replayFetch([
      { method: 'POST', url: (u) => u.href.startsWith(RUN_URL), response: { body: fixture('nova-3.nixon-call.diarize.json') } },
    ]);
    const ctx = testContext({ env, fetch });
    const res = await runChain('stt', rungs, (r) => r.transcribe(audio, { diarize: true }, ctx), { needs: ['diarization'] }, ctx);
    expect(res.rung.id).toBe(ID);
    expect(res.attempts.map((a) => a.id)).toEqual([ID]);
    expect(fetch.calls).toHaveLength(1);
  });
});
