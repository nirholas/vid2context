import { readFileSync } from 'node:fs';
import {
  type AudioChunk,
  type AudioSplitter,
  blockRms,
  id3v2Size,
  isVbrHeaderFrame,
  mp3FramesSplitter,
  parseMp3Header,
  parseWav,
  scanMp3,
  wavPcmSplitter,
} from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { fixtureBytes } from './helpers.ts';

const apolloMp3 = new Uint8Array(
  readFileSync(new URL('../../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url)),
);
const apolloWav = fixtureBytes('apollo11-small-step.wav');
const ctx = testContext();
/** MPEG-2 Layer III at 16 kHz: 576 samples per frame. */
const FRAME_SEC = 576 / 16000;

async function split(
  splitter: AudioSplitter,
  data: Uint8Array,
  filename: string,
  opts: { maxBytes: number; targetSec?: number; overlapSec?: number },
) {
  const out: AudioChunk[] = [];
  for await (const c of splitter.split({ kind: 'bytes', data, mimeType: 'application/octet-stream', filename }, opts, ctx))
    out.push(c);
  return out;
}

describe('mp3-frames splitter', () => {
  it('walks every frame of the apollo clip, skipping the ID3v2 tag and the Info frame', () => {
    const tag = id3v2Size(apolloMp3);
    const first = parseMp3Header(apolloMp3, tag);
    expect(first).not.toBeNull();
    const frames = scanMp3(apolloMp3);
    // ffprobe reports 24.192 s for this file.
    expect(frames.times.at(-1)).toBeCloseTo(24.192, 3);
    expect(frames.resyncs).toBe(0);
    if (first && isVbrHeaderFrame(apolloMp3, tag, first)) expect(frames.offsets[0]).toBe(tag + first.length);
  });

  it('skips the ID3v2 tag and the Info header of an ffmpeg-encoded file', () => {
    const data = fixtureBytes('doubleday-ch00-90s.mp3');
    const tag = id3v2Size(data);
    expect(tag).toBeGreaterThan(10);
    const h = parseMp3Header(data, tag);
    expect(h && isVbrHeaderFrame(data, tag, h)).toBe(true);
    const frames = scanMp3(data);
    expect(frames.offsets[0]).toBe(tag + (h?.length ?? 0));
    expect(frames.times.at(-1)).toBeCloseTo(90, 0);
  });

  it('splits into frame-aligned chunks under the byte cap with the configured overlap', async () => {
    const total = scanMp3(apolloMp3).times.at(-1) as number;
    const chunks = await split(mp3FramesSplitter, apolloMp3, 'apollo.mp3', { maxBytes: 40_000, overlapSec: 2 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    let covered = 0;
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.audio.data.byteLength).toBeLessThanOrEqual(40_000);
      expect(parseMp3Header(c.audio.data, 0)).not.toBeNull();
      // Each chunk is a complete frame sequence on its own.
      const own = scanMp3(c.audio.data);
      expect(own.resyncs).toBe(0);
      expect(own.times.at(-1)).toBeCloseTo(c.durationSec, 6);
      expect(c.audio.filename).toBe(`apollo-part${i + 1}.mp3`);
      if (i === 0) expect(c.overlapSec).toBe(0);
      else {
        expect(Math.abs(c.overlapSec - 2)).toBeLessThanOrEqual(FRAME_SEC);
        const prev = chunks[i - 1] as AudioChunk;
        expect(c.startSec + c.overlapSec).toBeCloseTo(prev.startSec + prev.durationSec, 6);
      }
      covered += c.durationSec - c.overlapSec;
    });
    expect(Math.abs(covered - total)).toBeLessThanOrEqual(FRAME_SEC);
  });

  it('resyncs over damaged bytes and keeps every intact frame', () => {
    const frames = scanMp3(apolloMp3);
    // A damaged copy of the real file: 37 zero bytes written over the middle of frame 300.
    const damaged = apolloMp3.slice();
    damaged.fill(0, (frames.offsets[300] as number) + 1, (frames.offsets[300] as number) + 38);
    const scanned = scanMp3(damaged);
    expect(scanned.resyncs).toBe(1);
    expect(scanned.offsets.length).toBe(frames.offsets.length - 1);
  });

  it('claims MP3 bytes and leaves other containers alone', () => {
    expect(mp3FramesSplitter.canSplit({ kind: 'bytes', data: apolloMp3, mimeType: 'audio/mpeg', filename: 'a.mp3' })).toBe(true);
    expect(mp3FramesSplitter.canSplit({ kind: 'bytes', data: apolloWav, mimeType: 'audio/wav', filename: 'a.wav' })).toBe(false);
    expect(wavPcmSplitter.canSplit({ kind: 'bytes', data: apolloMp3, mimeType: 'audio/mpeg', filename: 'a.mp3' })).toBe(false);
  });
});

describe('wav-pcm splitter', () => {
  it('parses fmt and data and skips the LIST chunk', () => {
    const info = parseWav(apolloWav);
    expect(info).toMatchObject({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, blockAlign: 2 });
    // RIFF header 12 + fmt 24 + LIST 34 (26 bytes of body) + data header 8.
    expect(info.dataOffset).toBe(78);
    expect(info.dataLength).toBe(apolloWav.byteLength - 78);
  });

  it('writes a correct 44-byte header per chunk and cuts on sample frames', async () => {
    const info = parseWav(apolloWav);
    const total = info.dataLength / (info.sampleRate * info.blockAlign);
    const chunks = await split(wavPcmSplitter, apolloWav, 'apollo.wav', { maxBytes: 10_000_000, targetSec: 8, overlapSec: 2 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    let covered = 0;
    for (const [i, c] of chunks.entries()) {
      const d = c.audio.data;
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const str = (at: number) => String.fromCharCode(...d.subarray(at, at + 4));
      expect([str(0), str(8), str(12), str(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
      expect(v.getUint32(4, true)).toBe(d.byteLength - 8);
      expect(v.getUint32(16, true)).toBe(16);
      expect(v.getUint32(40, true)).toBe(d.byteLength - 44);
      expect((d.byteLength - 44) % info.blockAlign).toBe(0);
      const own = parseWav(d);
      expect(own).toMatchObject({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataOffset: 44 });
      expect(own.dataLength / 32000).toBeCloseTo(c.durationSec, 6);
      expect(c.overlapSec).toBeCloseTo(i === 0 ? 0 : 2, 6);
      covered += c.durationSec - c.overlapSec;
    }
    expect(covered).toBeCloseTo(total, 6);
  });

  it('moves each cut into the quietest 20 ms block nearby', async () => {
    const info = parseWav(apolloWav);
    const rms = blockRms(apolloWav, info);
    const total = info.dataLength / 32000;
    const chunks = await split(wavPcmSplitter, apolloWav, 'apollo.wav', { maxBytes: 10_000_000, targetSec: 8, overlapSec: 2 });
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1] as AudioChunk;
      const cut = Math.round((prev.startSec + prev.durationSec) / 0.02);
      const level = rms[cut] as number;
      // The cut block is the quietest within 0.3 s either side, and quieter than the even cut point it replaced.
      // (The clip carries radio static, so even its pauses sit near the median level.)
      for (let b = Math.max(0, cut - 15); b <= Math.min(rms.length - 1, cut + 15); b++)
        expect(level).toBeLessThanOrEqual(rms[b] as number);
      const even = rms[Math.round((i * total) / chunks.length / 0.02)] as number;
      expect(level).toBeLessThan(even);
    }
  });
});
