import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import stt from '@vid2context/provider-stt-openai-compatible';
import { describe, expect, it } from 'vitest';
import { Registry, transcribe } from '../../src/index.ts';
import { replayFetch, testContext } from '../../src/testing.ts';
import { fixture, ROOT } from './helpers.ts';

const OVH_STT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';
const ref = { input: 'apollo.mp3', platform: 'file', kind: 'video' as const, id: 'file:apollo', nativeId: 'apollo' };
const audio = {
  kind: 'bytes' as const,
  data: new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/media/apollo11-small-step.mp3'))),
  mimeType: 'audio/mpeg',
  filename: 'apollo11-small-step.mp3',
};

function run(response: string) {
  const fetch = replayFetch([{ method: 'POST', url: OVH_STT, response: { body: response } }]);
  return transcribe(new Registry([stt], 'node'), ref, audio, {}, testContext({ fetch }));
}

describe('transcribe runs the repetition guard', () => {
  it('collapses the recorded OVH loop and records clean/repetition-guard in attempts', async () => {
    // The response was recorded for a looped 0.5 s snippet of the Apollo clip (see test/fixtures/clean/README.md).
    const res = await run(fixture('ovh-whisper-loop.verbose.json'));
    expect(res.transcript.segments).toEqual([{ startSec: 0, endSec: 20, text: 'ギギ', confidence: 0.2 }]);
    expect(res.attempts.at(-1)).toEqual({
      id: 'clean/repetition-guard',
      stage: 'stt',
      outcome: 'ok',
      detail: 'collapsed 1 segments',
    });
  });

  it('adds no attempt and changes nothing for the clean Apollo transcript', async () => {
    const res = await run(
      readFileSync(join(ROOT, 'providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json'), 'utf8'),
    );
    expect(res.attempts.some((a) => a.id === 'clean/repetition-guard')).toBe(false);
    expect(res.transcript.segments.map((s) => s.text)).toEqual([
      "I'm going to step off the limb now.",
      "That's one small step for man, one giant leap for mankind.",
    ]);
  });
});

describe.skipIf(!process.env.LIVE)('live: keyless OVH speech-to-text on the Apollo clip', () => {
  it('the guard leaves a clean real transcript unchanged', async () => {
    const res = await transcribe(new Registry([stt], 'node'), ref, audio, { chain: { only: ['ovh'] } }, testContext({ fetch }));
    expect(res.transcript.segments.length).toBeGreaterThan(0);
    expect(res.transcript.segments.map((s) => s.text).join(' ')).toMatch(/one small step/i);
    expect(res.attempts.some((a) => a.id === 'clean/repetition-guard')).toBe(false);
  }, 120_000);
});
