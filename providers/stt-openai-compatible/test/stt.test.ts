import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, isRungEnabled, rankRungs, type SttRung } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { normalizeLanguage, sttRungs, uploadFilename } from '../src/index.ts';

// Real recordings from OVH AI Endpoints, 2026-11-14 (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const apollo = new Uint8Array(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/media/apollo11-small-step.mp3')));
const OVH_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';

function ovhRung(env = {}): SttRung {
  const r = sttRungs(env).find((x) => x.service === 'ovh');
  if (!r) throw new Error('ovh rung missing');
  return r;
}

const audio = { kind: 'bytes' as const, data: apollo, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' };

describe('rungs from env', () => {
  it('enables only the keyless OVH rung with no configuration', () => {
    const enabled = sttRungs({}).filter((r) => isRungEnabled(r, {}));
    expect(enabled.map((r) => r.id)).toEqual(['stt/ovh/whisper-large-v3-turbo']);
  });

  it('adds one Groq rung per pooled key, local first, paid last', () => {
    const env = {
      GROQ_API_KEY: 'gsk_a',
      GROQ_FALLBACK_KEYS: 'gsk_b, gsk_a',
      OPENAI_API_KEY: 'sk-x',
      LOCAL_STT_BASE_URL: 'http://localhost:8000/v1',
      LOCAL_STT_MODEL: 'Systran/faster-whisper-large-v3',
    };
    expect(rankRungs(sttRungs(env), {}, env).map((r) => r.id)).toEqual([
      'stt/local/Systran/faster-whisper-large-v3',
      'stt/groq/whisper-large-v3-turbo',
      'stt/groq#2/whisper-large-v3-turbo',
      'stt/ovh/whisper-large-v3-turbo',
      'stt/openai/whisper-1',
    ]);
  });

  it('honours model overrides', () => {
    expect(ovhRung({ OVH_STT_MODEL: 'whisper-large-v3' }).id).toBe('stt/ovh/whisper-large-v3');
  });
});

describe('transcription (recorded OVH responses)', () => {
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
    expect(form.get('language')).toBe('en');
    expect((form.get('file') as File).name).toBe('apollo11-small-step.mp3');
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
    });
  });

  it('refuses audio above the rung upload limit before uploading', async () => {
    const groq = sttRungs({ GROQ_API_KEY: 'gsk_a' }).find((r) => r.service === 'groq');
    const big = { ...audio, data: new Uint8Array(26 * 1024 * 1024) };
    const fetch = replayFetch([]);
    await expect(groq?.transcribe(big, {}, testContext({ fetch }))).rejects.toMatchObject({ code: 'too-large' });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('fixes upload filenames from the mime type', () => {
    expect(uploadFilename('audio.out', 'audio/mpeg')).toBe('audio.mp3');
    expect(uploadFilename('episode', 'audio/mp4; codecs=mp4a')).toBe('episode.m4a');
    expect(uploadFilename('talk.webm', 'audio/webm')).toBe('talk.webm');
  });

  it('normalises Whisper language names and codes', () => {
    expect(normalizeLanguage('english')).toBe('en');
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('pt-BR')).toBe('pt-BR');
    expect(normalizeLanguage('')).toBeUndefined();
  });
});

describe.skipIf(!process.env.LIVE)('OVH keyless Whisper (live)', () => {
  it('transcribes the Apollo 11 clip', async () => {
    const ctx = createContext({ runtime: 'node', env: process.env });
    const res = await ovhRung().transcribe(audio, {}, ctx);
    expect(res.language).toBe('en');
    expect(res.segments.map((s) => s.text).join(' ')).toMatch(/one small step/i);
  });
});
