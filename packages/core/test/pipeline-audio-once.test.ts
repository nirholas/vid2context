import { readFileSync } from 'node:fs';
import { type AudioInput, clearCooldowns, Registry, transcribe, type VideoRef } from '@vid2context/core';
import { type RecordedResponse, replayFetch, testContext } from '@vid2context/core/testing';
import sttProvider from '@vid2context/provider-stt-openai-compatible';
import { beforeEach, describe, expect, it } from 'vitest';

// Real recordings from providers/stt-openai-compatible/test/fixtures (see its README.md) and the public-domain Apollo 11 clip.
const sttFixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../providers/stt-openai-compatible/test/fixtures/${name}`, import.meta.url), 'utf8'),
  ) as RecordedResponse;
const apollo = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url)));

const AUDIO_URL = 'https://media.example-cdn.net/apollo11-small-step.mp3';
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OVH_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';
const ref: VideoRef = {
  input: AUDIO_URL,
  platform: 'media',
  kind: 'video',
  id: 'media:apollo11-small-step',
  nativeId: 'apollo11-small-step',
  url: AUDIO_URL,
};
const registry = new Registry([sttProvider], 'node');

beforeEach(() => clearCooldowns());

function routes() {
  return replayFetch([
    {
      method: 'GET',
      url: AUDIO_URL,
      response: { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: apollo },
    },
    { method: 'POST', url: GROQ_URL, response: sttFixture('groq-401-no-key.response.json') },
    { method: 'POST', url: OVH_URL, response: sttFixture('ovh-json.response.json') },
  ]);
}

describe('transcribe with URL audio', () => {
  it('downloads the audio once even when the chain falls through several rungs', async () => {
    const fetch = routes();
    // Groq (free tier) ranks before keyless OVH; its recorded 401 makes the chain fall through to OVH.
    const ctx = testContext({ fetch, env: { GROQ_API_KEY: 'gsk_revoked' } });
    const audio: AudioInput = { kind: 'url', url: AUDIO_URL, mimeType: 'audio/mpeg' };
    const { transcript, attempts } = await transcribe(registry, ref, audio, {}, ctx);

    expect(transcript.producer).toBe('stt/ovh/whisper-large-v3-turbo');
    expect(transcript.segments.map((s) => s.text).join(' ')).toContain('one small step for man');
    expect(attempts.filter((a) => a.stage === 'stt').map((a) => [a.id, a.outcome])).toEqual([
      ['stt/groq/whisper-large-v3-turbo', 'error'],
      ['stt/ovh/whisper-large-v3-turbo', 'ok'],
    ]);
    const downloads = fetch.calls.filter((c) => c.url === AUDIO_URL);
    expect(downloads).toHaveLength(1);
    // Both rungs received the same bytes as an upload rather than fetching the URL themselves.
    expect(fetch.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('does not download when no speech-to-text rung is enabled', async () => {
    const fetch = routes();
    const ctx = testContext({ fetch });
    const empty = new Registry([], 'node');
    const audio: AudioInput = { kind: 'url', url: AUDIO_URL, mimeType: 'audio/mpeg' };
    await expect(transcribe(empty, ref, audio, {}, ctx)).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('reports a failed download as an audio attempt', async () => {
    const fetch = replayFetch([{ method: 'GET', url: AUDIO_URL, response: { status: 404, body: '' } }]);
    const ctx = testContext({ fetch });
    const audio: AudioInput = { kind: 'url', url: AUDIO_URL, mimeType: 'audio/mpeg' };
    const err = await transcribe(registry, ref, audio, {}, ctx).catch((e: unknown) => e);
    expect((err as { attempts?: { id: string; stage: string }[] }).attempts?.at(-1)).toMatchObject({
      id: 'stt/audio-download',
      stage: 'audio',
    });
  });
});
