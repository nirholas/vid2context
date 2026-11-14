/**
 * MP3 frame splitter. Pure TypeScript, so it runs on Node, Workers and in the
 * browser. It walks MPEG-1, MPEG-2 and MPEG-2.5 Layer III frame headers and
 * cuts only on frame boundaries, so every chunk is a valid MP3 stream on its
 * own. Time comes from frame counts (1152 or 576 samples per frame), which is
 * exact for CBR and VBR alike.
 *
 * Limits: it cannot detect silence without decoding, so cuts land near the
 * target length rather than in pauses (the overlap and the stitcher cover
 * words on a cut). Free-format streams (bitrate index 0) have no computable
 * frame length; the walker resyncs on the next valid header and skips them.
 */
import type { AudioBytes, AudioChunk, AudioSplitter, SplitOptions } from '../audio-split.ts';
import { Vid2ContextError } from '../errors.ts';
import type { AudioInput } from '../types.ts';
import { planCuts } from './plan.ts';

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

export interface Mp3FrameHeader {
  /** 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5 (the raw version bits). */
  version: number;
  bitrateKbps: number;
  sampleRate: number;
  padding: boolean;
  mono: boolean;
  /** Frame length in bytes, header included. */
  length: number;
  /** PCM samples per channel this frame decodes to. */
  samples: number;
}

/** Parse a Layer III frame header at `pos`, or return null when the bytes there are not one. */
export function parseMp3Header(data: Uint8Array, pos: number): Mp3FrameHeader | null {
  if (pos + 4 > data.length) return null;
  const b0 = data[pos] as number;
  const b1 = data[pos + 1] as number;
  const b2 = data[pos + 2] as number;
  const b3 = data[pos + 3] as number;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0x03;
  if (version === 1) return null; // reserved
  const layer = (b1 >> 1) & 0x03;
  if (layer !== 1) return null; // only Layer III
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const srIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || srIndex === 3) return null; // free format or bad
  const sampleRate = SAMPLE_RATES[version]?.[srIndex];
  if (!sampleRate) return null;
  const bitrateKbps = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] as number;
  const padding = ((b2 >> 1) & 0x01) === 1;
  const mono = ((b3 >> 6) & 0x03) === 3;
  const coef = version === 3 ? 144 : 72;
  const length = Math.floor((coef * bitrateKbps * 1000) / sampleRate) + (padding ? 1 : 0);
  if (length < 4) return null;
  return { version, bitrateKbps, sampleRate, padding, mono, length, samples: version === 3 ? 1152 : 576 };
}

/** Bytes taken by ID3v2 tags at the start (several may be stacked). */
export function id3v2Size(data: Uint8Array): number {
  let pos = 0;
  while (pos + 10 <= data.length && data[pos] === 0x49 && data[pos + 1] === 0x44 && data[pos + 2] === 0x33) {
    const flags = data[pos + 5] as number;
    const s = [6, 7, 8, 9].map((i) => (data[pos + i] as number) & 0x7f);
    const size = ((s[0] as number) << 21) | ((s[1] as number) << 14) | ((s[2] as number) << 7) | (s[3] as number);
    pos += 10 + size + (flags & 0x10 ? 10 : 0);
  }
  return Math.min(pos, data.length);
}

/** True when the frame at `pos` carries a Xing, Info or VBRI header (a metadata frame with no audio). */
export function isVbrHeaderFrame(data: Uint8Array, pos: number, h: Mp3FrameHeader): boolean {
  const sideInfo = h.version === 3 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17;
  const tag = (at: number) => String.fromCharCode(...data.subarray(at, at + 4));
  const xing = tag(pos + 4 + sideInfo);
  return xing === 'Xing' || xing === 'Info' || tag(pos + 36) === 'VBRI';
}

export interface Mp3Frames {
  /** Byte offset of each audio frame. */
  offsets: number[];
  lengths: number[];
  /** Start time of each frame in seconds; `times[n]` is the total duration. */
  times: number[];
  /** Number of resyncs over bytes that were not a valid frame. */
  resyncs: number;
}

/** A header counts only when the next frame also parses (or the stream ends): this rejects false syncs inside audio data. */
function confirmed(data: Uint8Array, pos: number, end: number): Mp3FrameHeader | null {
  const h = parseMp3Header(data, pos);
  if (!h) return null;
  const next = pos + h.length;
  if (next > end) return null;
  if (next === end || end - next < 4) return h;
  const n = parseMp3Header(data, next);
  return n && n.version === h.version && n.sampleRate === h.sampleRate ? h : null;
}

/** Walk every audio frame of an MP3 byte stream. */
export function scanMp3(data: Uint8Array): Mp3Frames {
  let end = data.length;
  // ID3v1 trailer.
  if (end >= 128 && data[end - 128] === 0x54 && data[end - 127] === 0x41 && data[end - 126] === 0x47) end -= 128;
  const offsets: number[] = [];
  const lengths: number[] = [];
  const times: number[] = [0];
  let resyncs = 0;
  let pos = id3v2Size(data);
  let first = true;
  let t = 0;
  while (pos + 4 <= end) {
    // The first header must be confirmed by the one after it; later ones follow on from a known frame.
    const h = first ? confirmed(data, pos, end) : parseMp3Header(data, pos);
    if (!h || pos + h.length > end) {
      // Resync: scan to the next confirmed header.
      let p = pos + 1;
      while (p + 4 <= end && !confirmed(data, p, end)) p++;
      if (p + 4 > end) break;
      resyncs++;
      pos = p;
      continue;
    }
    if (first) {
      first = false;
      if (isVbrHeaderFrame(data, pos, h)) {
        pos += h.length;
        continue;
      }
    }
    offsets.push(pos);
    lengths.push(h.length);
    t += h.samples / h.sampleRate;
    times.push(t);
    pos += h.length;
  }
  return { offsets, lengths, times, resyncs };
}

/** Cheap sniff: an ID3v2 tag or an MPEG audio frame sync at the start. */
function looksLikeMp3(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return true;
  return parseMp3Header(data, 0) !== null;
}

function isMp3Type(audio: AudioInput): boolean {
  const mime = (audio.mimeType ?? '').split(';')[0]?.trim().toLowerCase();
  if (mime === 'audio/mpeg' || mime === 'audio/mp3' || mime === 'audio/mpeg3') return true;
  const name = audio.kind === 'bytes' ? audio.filename : audio.url;
  return /\.mp3(\?|#|$)/i.test(name);
}

export function baseName(audio: AudioBytes): string {
  return audio.filename.replace(/\.[^./]*$/, '') || 'audio';
}

export const mp3FramesSplitter: AudioSplitter = {
  id: 'mp3-frames',
  canSplit(audio) {
    if (audio.kind !== 'bytes') return isMp3Type(audio);
    return looksLikeMp3(audio.data) && (isMp3Type(audio) || !/^(audio|video)\/(mp4|x-m4a|m4a|webm|ogg|aac|wav|x-wav)/i.test(audio.mimeType));
  },
  async *split(audio, opts: SplitOptions) {
    if (audio.kind !== 'bytes') {
      throw new Vid2ContextError('bad-request', 'mp3-frames splits bytes; fetch the URL first.');
    }
    const frames = scanMp3(audio.data);
    const n = frames.offsets.length;
    if (n === 0) {
      throw new Vid2ContextError('unsupported-input', `${audio.filename} has no MPEG Layer III frames.`, {
        hint: 'Pass a valid MP3, or install the ffmpeg provider to convert the audio first.',
      });
    }
    const spanEnd = (i: number) => (frames.offsets[i] as number) + (frames.lengths[i] as number);
    const bytesOf = (s: number, e: number) => spanEnd(e - 1) - (frames.offsets[s] as number);
    const cuts = planCuts({
      count: n,
      times: frames.times,
      bytesOf,
      maxBytes: opts.maxBytes,
      targetSec: opts.targetSec ?? 600,
      overlapSec: opts.overlapSec ?? 2,
      unit: 'frame',
    });
    const base = baseName(audio);
    for (const [index, c] of cuts.entries()) {
      const chunk: AudioChunk = {
        index,
        startSec: frames.times[c.start] as number,
        durationSec: (frames.times[c.end] as number) - (frames.times[c.start] as number),
        overlapSec: c.overlapSec,
        audio: {
          kind: 'bytes',
          data: audio.data.subarray(frames.offsets[c.start] as number, spanEnd(c.end - 1)),
          mimeType: 'audio/mpeg',
          filename: `${base}-part${index + 1}.mp3`,
          durationSec: (frames.times[c.end] as number) - (frames.times[c.start] as number),
        },
      };
      yield chunk;
    }
  },
};
