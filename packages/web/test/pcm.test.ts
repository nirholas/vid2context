/**
 * The WAV reader the speech-to-text worker uses instead of Web Audio
 * (src/audio/pcm.ts). The input is real: the public-domain Apollo 11 clip,
 * decoded to 16 kHz mono by ffmpeg (tests/fixtures/README.md), encoded with
 * the app's own encodeWav.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePcmWav } from '../src/audio/pcm.ts';
import { encodeWav } from '../src/audio/wav.ts';
import { ROOT } from './helpers.ts';

const APOLLO = join(ROOT, 'tests', 'fixtures', 'media', 'apollo11-small-step.mp3');

/** 16 kHz mono float samples of the clip, from ffmpeg. */
function apolloSamples(): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', APOLLO, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

describe('decodePcmWav', () => {
  const samples = apolloSamples();
  const wav = encodeWav(samples, 16_000);

  it('reads the app WAV back to the same samples, within 16-bit rounding', () => {
    const back = decodePcmWav(wav);
    expect(back).not.toBeNull();
    expect(back?.length).toBe(samples.length);
    let worst = 0;
    for (let i = 0; i < samples.length; i++)
      worst = Math.max(worst, Math.abs((back?.[i] ?? 0) - Math.max(-1, Math.min(1, samples[i] ?? 0))));
    // The encoder scales by 0x7fff and the reader by 0x8000: two quantization steps at most.
    expect(worst).toBeLessThan(2 / 0x8000);
    // About 24 s at 16 kHz (tests/fixtures/README.md).
    expect(samples.length / 16_000).toBeGreaterThan(24);
  });

  it('walks past other chunks and reads a WAV ffmpeg wrote, with a LIST chunk before data', () => {
    const ff = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', APOLLO, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', '-'],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const bytes = new Uint8Array(ff.buffer, ff.byteOffset, ff.byteLength);
    expect(new TextDecoder('latin1').decode(bytes.subarray(0, 200))).toContain('LIST');
    const back = decodePcmWav(bytes);
    expect(back?.length).toBe(samples.length);
  });

  it('declines what it cannot read, so a full decoder takes over', () => {
    expect(decodePcmWav(encodeWav(samples.subarray(0, 4410), 44_100))).toBeNull();
    expect(decodePcmWav(new TextEncoder().encode('ID3 not a wav file at all, but long enough to have a header'))).toBeNull();
    expect(decodePcmWav(new Uint8Array(10))).toBeNull();
  });
});
