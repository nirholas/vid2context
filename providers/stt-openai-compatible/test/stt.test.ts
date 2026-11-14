import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, isRungEnabled, rankRungs, type SttRung } from '@vid2context/core';
import { type RecordedResponse, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import {
  normalizeLanguage,
  parseDuration,
  parseVerboseJson,
  promptFromMetadata,
  retryAfterFromHeaders,
  sttRungs,
  uploadFilename,
  uploadMimeType,
  type WordSegment,
} from '../src/index.ts';

// Real recordings, 2026-11-14 (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
/** A recorded response envelope: { status, headers, body } exactly as the service sent it. */
const recorded = (name: string) =>
  JSON.parse(fixture(name)) as { status: number; headers: Record<string, string>; body: string } & RecordedResponse;
const apollo = new Uint8Array(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/media/apollo11-small-step.mp3')));
const OVH_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';

function find(service: string, env: Record<string, string | undefined> = {}): SttRung {
  const r = sttRungs(env).find((x) => x.service === service);
  if (!r) throw new Error(`${service} rung missing`);
  return r;
}
const ovhRung = (env: Record<string, string | undefined> = {}) => find('ovh', env);

const audio = { kind: 'bytes' as const, data: apollo, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' };

describe('rungs from env', () => {
  it('enables only the keyless OVH rung with no configuration, and lists every other rung disabled with its requires', () => {
    const rungs = sttRungs({});
    expect(rungs.filter((r) => isRungEnabled(r, {})).map((r) => r.id)).toEqual(['stt/ovh/whisper-large-v3-turbo']);
    expect(rungs.filter((r) => !isRungEnabled(r, {})).map((r) => [r.id, r.requires])).toEqual([
      ['stt/local', ['LOCAL_STT_BASE_URL', 'LOCAL_STT_MODEL']],
      ['stt/groq/whisper-large-v3-turbo', ['GROQ_API_KEY']],
      ['stt/mistral/voxtral-mini-transcribe-3', ['MISTRAL_API_KEY']],
      ['stt/deepinfra/openai/whisper-large-v3-turbo', ['DEEPINFRA_API_KEY']],
      ['stt/together/openai/whisper-large-v3', ['TOGETHER_API_KEY']],
      ['stt/openai/whisper-1', ['OPENAI_API_KEY']],
    ]);
  });

  it('orders local, free (Groq first), keyless, then paid cheapest first, one rung per pooled key', () => {
    const env = {
      GROQ_API_KEY: 'gsk_a',
      GROQ_FALLBACK_KEYS: 'gsk_b, gsk_a',
      MISTRAL_API_KEY: 'm_a',
      DEEPINFRA_API_KEY: 'di_a',
      TOGETHER_API_KEY: 'tg_a',
      OPENAI_API_KEY: 'sk-x',
      LOCAL_STT_BASE_URL: 'http://localhost:8000/v1',
      LOCAL_STT_MODEL: 'Systran/faster-whisper-large-v3',
    };
    const ranked = rankRungs(sttRungs(env), {}, env);
    expect(ranked.map((r) => r.id)).toEqual([
      'stt/local/Systran/faster-whisper-large-v3',
      'stt/groq/whisper-large-v3-turbo',
      'stt/groq#2/whisper-large-v3-turbo',
      'stt/mistral/voxtral-mini-transcribe-3',
      'stt/ovh/whisper-large-v3-turbo',
      'stt/deepinfra/openai/whisper-large-v3-turbo',
      'stt/together/openai/whisper-large-v3',
      'stt/openai/whisper-1',
    ]);
    expect(ranked.slice(1, 3).map((r) => [r.service, r.requires])).toEqual([
      ['groq', ['GROQ_API_KEY']],
      ['groq#2', ['GROQ_FALLBACK_KEYS']],
    ]);
  });

  it('honours every model override', () => {
    const env = {
      OVH_STT_MODEL: 'whisper-large-v3',
      GROQ_API_KEY: 'g',
      GROQ_STT_MODEL: 'whisper-large-v3',
      MISTRAL_API_KEY: 'm',
      MISTRAL_STT_MODEL: 'voxtral-small-transcribe-3',
      DEEPINFRA_API_KEY: 'd',
      DEEPINFRA_STT_MODEL: 'openai/whisper-large-v3',
      TOGETHER_API_KEY: 't',
      TOGETHER_STT_MODEL: 'nvidia/parakeet-tdt-0.6b-v3',
      OPENAI_API_KEY: 'o',
      OPENAI_STT_MODEL: 'gpt-4o-transcribe',
    };
    expect(sttRungs(env).map((r) => r.id)).toEqual([
      'stt/local',
      'stt/groq/whisper-large-v3',
      'stt/mistral/voxtral-small-transcribe-3',
      'stt/ovh/whisper-large-v3',
      'stt/deepinfra/openai/whisper-large-v3',
      'stt/together/nvidia/parakeet-tdt-0.6b-v3',
      'stt/openai/gpt-4o-transcribe',
    ]);
  });

  it('declares words only where the service returns them', () => {
    const caps = Object.fromEntries(sttRungs({}).map((r) => [r.service, r.capabilities.includes('words')]));
    expect(caps).toEqual({ local: false, groq: true, mistral: false, ovh: true, deepinfra: true, together: true, openai: true });
    expect(ovhRung().capabilities).toEqual(['segments', 'words', 'language-detect', 'prompt']);
  });
});

describe('OVH transcription (recorded responses)', () => {
  it('uploads multipart verbose_json without an Authorization header and parses segments', async () => {
    const fetch = replayFetch([
      { method: 'POST', url: OVH_URL, response: { body: fixture('ovh-whisper-large-v3-turbo.verbose.json') } },
    ]);
    const res = await ovhRung().transcribe(audio, { language: 'en-US' }, testContext({ fetch }));
    expect(res).toEqual({
      language: 'en',
      model: 'whisper-large-v3-turbo',
      segments: [
        { startSec: 0, endSec: 7, text: "I'm going to step off the limb now." },
        { startSec: 7, endSec: 23.06, text: "That's one small step for man, one giant leap for mankind." },
      ],
    });
    const call = fetch.calls[0];
    expect(call?.headers.authorization).toBeUndefined();
    const form = call?.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBeNull();
    const file = form.get('file') as File;
    expect(file.name).toBe('apollo11-small-step.mp3');
    expect(file.type).toBe('audio/mpeg');
  });

  it('attaches word timestamps to the segment they fall in', async () => {
    const fetch = replayFetch([{ url: OVH_URL, response: recorded('ovh-whisper-large-v3-turbo.words.response.json') }]);
    const res = await ovhRung().transcribe(audio, {}, testContext({ fetch }));
    const segs = res.segments as WordSegment[];
    expect(segs.map((s) => [s.startSec, s.endSec, s.words?.length])).toEqual([
      [3.5, 5.16, 8],
      [14.98, 23.04, 11],
    ]);
    expect(segs[1]?.words?.slice(1, 3)).toEqual([
      { word: 'one', startSec: 15.7, endSec: 15.96 },
      { word: 'small', startSec: 15.96, endSec: 16.48 },
    ]);
    expect(res.language).toBe('en');
  });

  it('turns json and plain text responses into one segment spanning the known duration', async () => {
    const json = replayFetch([{ url: OVH_URL, response: recorded('ovh-json.response.json') }]);
    const a = await ovhRung().transcribe({ ...audio, durationSec: 24.1 }, { language: 'en' }, testContext({ fetch: json }));
    expect(a.segments).toEqual([
      {
        startSec: 0,
        endSec: 24.1,
        text: "I'm going to step off the limb now. That's one small step for man, one giant leap for mankind.",
      },
    ]);
    expect(a.language).toBe('en');

    const text = replayFetch([{ url: OVH_URL, response: recorded('ovh-text.response.json') }]);
    const b = await ovhRung().transcribe(audio, {}, testContext({ fetch: text }));
    expect(b.segments[0]?.text).toMatch(/^I'm going .*mankind\.$/);
    expect(b.language).toBe('und');
  });

  it('sends the prompt, cut to the service limit at a word boundary', async () => {
    const fetch = replayFetch([{ url: OVH_URL, response: recorded('ovh-json.response.json') }]);
    const prompt = `Apollo 11. Neil Armstrong. ${'Tranquility Base '.repeat(80)}`;
    await ovhRung().transcribe(audio, { prompt }, testContext({ fetch }));
    const sent = (fetch.calls[0]?.body as FormData | undefined)?.get('prompt') as string;
    expect(sent.startsWith('Apollo 11. Neil Armstrong.')).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(800);
    expect(sent.endsWith('Base')).toBe(true);
  });

  it('maps the real 429 to rate-limited with Retry-After, and the 400 to a fall-through upstream error', async () => {
    const limited = replayFetch([
      { url: OVH_URL, response: { status: 429, headers: { 'retry-after': '31' }, body: fixture('ovh-429.json') } },
    ]);
    await expect(ovhRung().transcribe(audio, {}, testContext({ fetch: limited }))).rejects.toMatchObject({
      code: 'rate-limited',
      retryAfterSec: 31,
    });
    const bad = replayFetch([{ url: OVH_URL, response: { status: 400, body: fixture('ovh-400-extension.json') } }]);
    await expect(ovhRung().transcribe(audio, {}, testContext({ fetch: bad }))).rejects.toMatchObject({
      code: 'upstream',
      status: 400,
      hint: expect.stringMatching(/file format/),
    });
  });

  it('reads Retry-After from the recorded 429 headers and keeps at least a 30 s cooldown on OVH', async () => {
    const long = replayFetch([{ url: OVH_URL, response: recorded('ovh-429-headers.response.json') }]);
    await expect(ovhRung().transcribe(audio, {}, testContext({ fetch: long }))).rejects.toMatchObject({
      code: 'rate-limited',
      retryAfterSec: 56,
    });
    const short = replayFetch([{ url: OVH_URL, response: recorded('ovh-429-short.response.json') }]);
    await expect(ovhRung().transcribe(audio, {}, testContext({ fetch: short }))).rejects.toMatchObject({
      code: 'rate-limited',
      retryAfterSec: 30,
    });
  });

  it('maps model_not_found to not-found with the env var that fixes it', async () => {
    const fetch = replayFetch([{ url: OVH_URL, response: recorded('ovh-404-model.response.json') }]);
    await expect(ovhRung({ OVH_STT_MODEL: 'whisper-nope' }).transcribe(audio, {}, testContext({ fetch }))).rejects.toMatchObject({
      code: 'not-found',
      status: 404,
      hint: expect.stringContaining('OVH_STT_MODEL'),
    });
  });

  it('maps undecodable audio to bad-request so the chain stops instead of uploading it everywhere', async () => {
    const fetch = replayFetch([{ url: OVH_URL, response: recorded('ovh-400-corrupt.response.json') }]);
    await expect(ovhRung().transcribe(audio, {}, testContext({ fetch }))).rejects.toMatchObject({
      code: 'bad-request',
      status: 400,
      hint: expect.stringMatching(/could not be decoded/),
    });
  });

  it('downloads URL audio through ctx.fetch with a size cap', async () => {
    const mediaUrl = 'https://media.example.org/clips/apollo11';
    const fetch = replayFetch([
      { method: 'GET', url: mediaUrl, response: { headers: { 'content-type': 'audio/mpeg' }, body: apollo } },
      { method: 'POST', url: OVH_URL, response: recorded('ovh-json.response.json') },
    ]);
    const res = await ovhRung().transcribe({ kind: 'url', url: mediaUrl }, {}, testContext({ fetch }));
    expect(res.segments[0]?.text).toMatch(/small step/);
    const file = (fetch.calls[1]?.body as FormData | undefined)?.get('file') as File;
    expect(file.name).toBe('apollo11.mp3');
    expect(file.size).toBe(apollo.byteLength);

    const groq = find('groq', { GROQ_API_KEY: 'gsk_a' });
    const big = replayFetch([{ url: mediaUrl, response: { body: new Uint8Array(26 * 1024 * 1024) } }]);
    await expect(groq.transcribe({ kind: 'url', url: mediaUrl }, {}, testContext({ fetch: big }))).rejects.toMatchObject({
      code: 'too-large',
    });
    expect(big.calls).toHaveLength(1);
  });

  it('refuses bytes above the rung upload limit before uploading', async () => {
    const groq = find('groq', { GROQ_API_KEY: 'gsk_a' });
    const big = { ...audio, data: new Uint8Array(26 * 1024 * 1024) };
    const fetch = replayFetch([]);
    await expect(groq.transcribe(big, {}, testContext({ fetch }))).rejects.toMatchObject({ code: 'too-large' });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('keyed services (recorded responses to a request without a valid key)', () => {
  const cases = [
    {
      service: 'groq',
      key: 'gsk_test',
      env: { GROQ_API_KEY: 'gsk_test' },
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      fixture: 'groq-401-no-key.response.json',
      keyVar: 'GROQ_API_KEY',
    },
    {
      service: 'deepinfra',
      key: 'di_test',
      env: { DEEPINFRA_API_KEY: 'di_test' },
      url: 'https://api.deepinfra.com/v1/openai/audio/transcriptions',
      fixture: 'deepinfra-401-no-key.response.json',
      keyVar: 'DEEPINFRA_API_KEY',
    },
    {
      service: 'together',
      key: 'tg_test',
      env: { TOGETHER_API_KEY: 'tg_test' },
      url: 'https://api.together.xyz/v1/audio/transcriptions',
      fixture: 'together-401-no-key.response.json',
      keyVar: 'TOGETHER_API_KEY',
    },
  ];

  for (const c of cases) {
    it(`${c.service}: sends a bearer key, verbose_json and word granularity, and maps 401 to auth`, async () => {
      const fetch = replayFetch([{ method: 'POST', url: c.url, response: recorded(c.fixture) }]);
      const rung = find(c.service, c.env);
      await expect(
        rung.transcribe(audio, { language: 'fr-CA', prompt: 'Apollo 11.' }, testContext({ fetch })),
      ).rejects.toMatchObject({
        code: 'auth',
        status: 401,
        hint: expect.stringContaining(c.keyVar),
      });
      const call = fetch.calls[0];
      expect(call?.headers.authorization).toBe(`Bearer ${c.key}`);
      const form = call?.body as FormData;
      expect(form.get('model')).toBe(rung.model);
      expect(form.get('response_format')).toBe('verbose_json');
      expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
      expect(form.get('language')).toBe('fr');
      expect(form.get('prompt')).toBe('Apollo 11.');
    });
  }

  it('the pooled Groq rung uses its own key and names its own env var in the hint', async () => {
    const rung = find('groq#2', { GROQ_API_KEY: 'gsk_test', GROQ_FALLBACK_KEYS: 'gsk_test2' });
    const fetch = replayFetch([
      { url: 'https://api.groq.com/openai/v1/audio/transcriptions', response: recorded('groq-401-no-key.response.json') },
    ]);
    await expect(rung.transcribe(audio, {}, testContext({ fetch }))).rejects.toMatchObject({
      hint: expect.stringContaining('GROQ_FALLBACK_KEYS'),
    });
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer gsk_test2');
  });

  it('mistral: speaks its own dialect (segment timestamps, context_bias, return_language) and maps 401 to auth', async () => {
    const url = 'https://api.mistral.ai/v1/audio/transcriptions';
    const rung = find('mistral', { MISTRAL_API_KEY: 'm_test' });
    const fetch = replayFetch([{ method: 'POST', url, response: recorded('mistral-401-no-key.response.json') }]);
    await expect(rung.transcribe(audio, { prompt: 'Apollo 11. Neil Armstrong.' }, testContext({ fetch }))).rejects.toMatchObject({
      code: 'auth',
      hint: expect.stringContaining('MISTRAL_API_KEY'),
    });
    const form = fetch.calls[0]?.body as FormData;
    expect([...form.keys()]).toEqual(['file', 'model', 'timestamp_granularities', 'return_language', 'context_bias']);
    expect(form.get('timestamp_granularities')).toBe('segment');
    expect(form.get('context_bias')).toBe('Apollo 11. Neil Armstrong.');
    expect(form.get('response_format')).toBeNull();
  });
});

describe('helpers', () => {
  it('fixes upload filenames and content types', () => {
    expect(uploadFilename('audio.out', 'audio/mpeg')).toBe('audio.mp3');
    expect(uploadFilename('episode', 'audio/mp4; codecs=mp4a')).toBe('episode.m4a');
    expect(uploadFilename('talk.webm', 'audio/webm')).toBe('talk.webm');
    expect(uploadMimeType('talk.webm', 'application/octet-stream')).toBe('audio/webm');
    expect(uploadMimeType('a.mp3', 'audio/mpeg; charset=binary')).toBe('audio/mpeg');
  });

  it('normalises Whisper language names and codes', () => {
    expect(normalizeLanguage('english')).toBe('en');
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('pt-BR')).toBe('pt-BR');
    expect(normalizeLanguage('')).toBeUndefined();
  });

  it('parses rate-limit durations and headers in the documented formats', () => {
    expect(parseDuration('2m59.56s')).toBeCloseTo(179.56);
    expect(parseDuration('7.66s')).toBeCloseTo(7.66);
    expect(parseDuration('6ms')).toBeCloseTo(0.006);
    expect(parseDuration('soon')).toBeUndefined();
    expect(retryAfterFromHeaders(new Headers(recorded('ovh-429-headers.response.json').headers))).toBe(56);
    expect(retryAfterFromHeaders(new Headers({ 'x-ratelimit-remaining-minute': '0' }))).toBe(60);
    expect(
      retryAfterFromHeaders(new Headers({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m59.56s' })),
    ).toBe(180);
    expect(retryAfterFromHeaders(new Headers({ 'x-ratelimit-remaining-requests': '5' }))).toBeUndefined();
  });

  it('builds a prompt from real video metadata within the limit', () => {
    const ctx = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-jNQXAC9IVRw.json'), 'utf8'),
    );
    const prompt = promptFromMetadata(ctx.metadata);
    expect(prompt.startsWith(`${ctx.metadata.title}.`)).toBe(true);
    expect(prompt).toContain(ctx.metadata.channel.name);
    expect(prompt.length).toBeLessThanOrEqual(800);
    const short = promptFromMetadata(
      {
        title: 'Apollo 11 landing',
        channel: { name: 'NASA' },
        chapters: [{ title: 'Descent', startSec: 0 }],
        tags: ['nasa', 'Eagle', 'Tranquility'],
      },
      40,
    );
    expect(short).toBe('Apollo 11 landing. NASA. Descent. Eagle.');
    expect(promptFromMetadata({ title: '' })).toBe('');
  });

  it('keeps per-segment words when a service nests them', () => {
    const r = parseVerboseJson({ segments: [{ start: 0, end: 1, text: ' hi ', words: [{ word: 'hi', start: 0, end: 0.5 }] }] });
    expect(r.segments).toEqual([{ startSec: 0, endSec: 1, text: 'hi', words: [{ word: 'hi', startSec: 0, endSec: 0.5 }] }]);
  });
});

const liveEnv = process.env as Record<string, string | undefined>;
const keyedLive = [
  ['groq', 'GROQ_API_KEY'],
  ['mistral', 'MISTRAL_API_KEY'],
  ['deepinfra', 'DEEPINFRA_API_KEY'],
  ['together', 'TOGETHER_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
] as const;

describe.skipIf(!process.env.LIVE)('speech-to-text rungs (live)', () => {
  it('OVH keyless transcribes the Apollo 11 clip with word timestamps', async () => {
    const ctx = createContext({ runtime: 'node', env: liveEnv });
    const res = await ovhRung(liveEnv).transcribe(audio, {}, ctx);
    expect(res.language).toBe('en');
    expect(res.segments.map((s) => s.text).join(' ')).toMatch(/small step/i);
    expect((res.segments as WordSegment[]).some((s) => (s.words?.length ?? 0) > 0)).toBe(true);
  });

  for (const [service, keyVar] of keyedLive) {
    it.skipIf(!liveEnv[keyVar])(`${service} transcribes the Apollo 11 clip (needs ${keyVar})`, async () => {
      const ctx = createContext({ runtime: 'node', env: liveEnv });
      const res = await find(service, liveEnv).transcribe(audio, { language: 'en' }, ctx);
      expect(res.segments.map((s) => s.text).join(' ')).toMatch(/small step/i);
    });
  }
});
