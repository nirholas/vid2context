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

/**
 * The whole clip answers with the recorded loop; its two retry pieces answer with `pieces` (the recorded responses
 * for apollo11-small-step-part1/2, or the loop again). The clip's real length is given, so the retry is two pieces.
 */
function runLooping(pieces: 'recorded' | 'loop') {
  const loop = fixture('ovh-whisper-loop.verbose.json');
  const fetch = replayFetch([
    {
      method: 'POST',
      url: OVH_STT,
      response: (call) => {
        const name = ((call.body as FormData).get('file') as File).name.replace(/\.[^.]+$/, '');
        if (name === 'apollo11-small-step' || pieces === 'loop') return { body: loop };
        return { body: fixture(`ovh-${name}.verbose.json`) };
      },
    },
  ]);
  const timed = { ...audio, durationSec: 24.192 };
  return { fetch, res: transcribe(new Registry([stt], 'node'), ref, timed, {}, testContext({ fetch })) };
}

describe('transcribe runs the repetition guard', () => {
  it('re-transcribes a looped answer in two pieces and keeps the real speech', async () => {
    // The loop was recorded for a looped 0.5 s snippet of the Apollo clip, the pieces for the clip's two halves
    // (see test/fixtures/clean/README.md).
    const { fetch, res } = runLooping('recorded');
    const out = await res;
    expect(fetch.calls).toHaveLength(3);
    expect(out.attempts[1]).toMatchObject({ reason: 'repetition-loop', outcome: 'error' });
    expect(out.attempts.some((a) => a.id === 'clean/repetition-guard')).toBe(false);
    expect(out.transcript.segments.map((s) => s.text)).toEqual([
      "I'm going to step off the lam now.",
      "That's one small step for man, one giant leap for mankind.",
    ]);
    expect(out.transcript.segments[1]?.startSec).toBeGreaterThan(10);
  });

  it('when the pieces loop too, collapses the loop and records clean/repetition-guard in attempts', async () => {
    const { fetch, res } = runLooping('loop');
    const out = await res;
    expect(fetch.calls).toHaveLength(3);
    // Each piece is cut back where it is kept; the stitched transcript then has nothing left for the final guard.
    expect(
      out.attempts.filter((a) => a.id === 'clean/repetition-guard' && a.reason === 'loop-kept').map((a) => a.detail),
    ).toEqual([
      'chunk 1/2: every retry still looped; the loop was cut back and the speech under it is missing',
      'chunk 2/2: every retry still looped; the loop was cut back and the speech under it is missing',
    ]);
    expect(out.transcript.segments.length).toBeGreaterThan(0);
    expect(out.transcript.segments.every((s) => s.text === 'ギギ' && s.confidence === 0.2)).toBe(true);
  });

  it('collapses at once, with no retry, when no splitter can cut the audio', async () => {
    // A WAV file name on MP3 bytes: the wav-pcm splitter claims it by name and finds no RIFF header, so the retry
    // fails and the single answer is collapsed, exactly as before retries existed.
    const fetch = replayFetch([{ method: 'POST', url: OVH_STT, response: { body: fixture('ovh-whisper-loop.verbose.json') } }]);
    const res = await transcribe(
      new Registry([stt], 'node'),
      ref,
      { ...audio, filename: 'apollo11-small-step.wav', mimeType: 'audio/wav' },
      {},
      testContext({ fetch }),
    );
    expect(fetch.calls).toHaveLength(1);
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
