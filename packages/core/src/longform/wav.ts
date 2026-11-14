/**
 * WAV (RIFF PCM) splitter. Pure TypeScript. It reads the `fmt ` and `data`
 * chunks (skipping LIST and any other chunk), slices samples on sample-frame
 * boundaries and writes a fresh 44-byte header for each chunk. Because PCM is
 * uncompressed, it measures loudness cheaply (RMS over 20 ms blocks) and
 * moves each cut to the quietest block near the even cut point, so cuts land
 * in pauses rather than mid-word.
 */
import type { AudioChunk, AudioSplitter, SplitOptions } from '../audio-split.ts';
import { Vid2ContextError } from '../errors.ts';
import type { AudioInput } from '../types.ts';
import { baseName } from './mp3.ts';
import { planCuts } from './plan.ts';

export interface WavInfo {
  /** 1 = integer PCM, 3 = IEEE float. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Bytes per sample frame (all channels). */
  blockAlign: number;
  dataOffset: number;
  dataLength: number;
}

const BLOCK_SEC = 0.02;
const HEADER_BYTES = 44;

function fourcc(data: Uint8Array, at: number): string {
  return String.fromCharCode(...data.subarray(at, at + 4));
}

/** Parse the RIFF/WAVE header. Throws `unsupported-input` for anything that is not PCM or float WAV. */
export function parseWav(data: Uint8Array): WavInfo {
  if (data.length < 12 || fourcc(data, 0) !== 'RIFF' || fourcc(data, 8) !== 'WAVE') {
    throw new Vid2ContextError('unsupported-input', 'Not a RIFF/WAVE file.', {
      hint: 'Pass a WAV file or another supported format.',
    });
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataLength'> | undefined;
  while (pos + 8 <= data.length) {
    const id = fourcc(data, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      let format = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format tag is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) break;
      // Streaming writers leave the size at 0 or 0xFFFFFFFF; clamp to what is really there.
      const dataLength = Math.min(size === 0 ? Number.POSITIVE_INFINITY : size, data.length - body);
      const ok =
        (fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bitsPerSample)) || (fmt.format === 3 && fmt.bitsPerSample === 32);
      if (!ok || fmt.channels < 1 || fmt.blockAlign < 1 || fmt.sampleRate < 1) {
        throw new Vid2ContextError(
          'unsupported-input',
          `WAV format ${fmt.format} with ${fmt.bitsPerSample}-bit samples is not supported.`,
          {
            hint: 'Use 8/16/24/32-bit integer PCM or 32-bit float WAV, or install the ffmpeg provider to convert it.',
          },
        );
      }
      return { ...fmt, dataOffset: body, dataLength: dataLength - (dataLength % fmt.blockAlign) };
    }
    pos = body + size + (size % 2); // chunks are padded to an even length
  }
  throw new Vid2ContextError('unsupported-input', 'WAV file has no fmt or data chunk.', {
    hint: 'The file may be truncated; re-export it.',
  });
}

/** A canonical 44-byte PCM header for `dataLength` bytes of samples. */
export function wavHeader(info: WavInfo, dataLength: number): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  const v = new DataView(out.buffer);
  const w = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataLength, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, info.format, true);
  v.setUint16(22, info.channels, true);
  v.setUint32(24, info.sampleRate, true);
  v.setUint32(28, info.sampleRate * info.blockAlign, true);
  v.setUint16(32, info.blockAlign, true);
  v.setUint16(34, info.bitsPerSample, true);
  w(36, 'data');
  v.setUint32(40, dataLength, true);
  return out;
}

/** Root-mean-square level (0..1) of each 20 ms block, all channels mixed. */
export function blockRms(data: Uint8Array, info: WavInfo): Float64Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const framesPerBlock = Math.max(1, Math.round(info.sampleRate * BLOCK_SEC));
  const totalFrames = info.dataLength / info.blockAlign;
  const blocks = Math.ceil(totalFrames / framesPerBlock);
  const out = new Float64Array(blocks);
  const bytes = info.bitsPerSample / 8;
  const read = (at: number): number => {
    if (info.format === 3) return view.getFloat32(at, true);
    switch (bytes) {
      case 1:
        return ((data[at] as number) - 128) / 128;
      case 2:
        return view.getInt16(at, true) / 32768;
      case 3: {
        const v = (data[at] as number) | ((data[at + 1] as number) << 8) | ((data[at + 2] as number) << 16);
        return ((v << 8) >> 8) / 8388608;
      }
      default:
        return view.getInt32(at, true) / 2147483648;
    }
  };
  for (let b = 0; b < blocks; b++) {
    const f0 = b * framesPerBlock;
    const f1 = Math.min(totalFrames, f0 + framesPerBlock);
    let sum = 0;
    let n = 0;
    for (let f = f0; f < f1; f++) {
      const at = info.dataOffset + f * info.blockAlign;
      for (let c = 0; c < info.channels; c++) {
        const x = read(at + c * bytes);
        sum += x * x;
        n++;
      }
    }
    out[b] = n > 0 ? Math.sqrt(sum / n) : 0;
  }
  return out;
}

function isWavType(audio: AudioInput): boolean {
  const mime = (audio.mimeType ?? '').split(';')[0]?.trim().toLowerCase();
  if (mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave' || mime === 'audio/vnd.wave') return true;
  return /\.wav(\?|#|$)/i.test(audio.kind === 'bytes' ? audio.filename : audio.url);
}

export const wavPcmSplitter: AudioSplitter = {
  id: 'wav-pcm',
  canSplit(audio) {
    if (audio.kind !== 'bytes') return isWavType(audio);
    const d = audio.data;
    return d.length >= 12 && fourcc(d, 0) === 'RIFF' && fourcc(d, 8) === 'WAVE';
  },
  async *split(audio, opts: SplitOptions) {
    if (audio.kind !== 'bytes') {
      throw new Vid2ContextError('bad-request', 'wav-pcm splits bytes; fetch the URL first.');
    }
    const info = parseWav(audio.data);
    const framesPerBlock = Math.max(1, Math.round(info.sampleRate * BLOCK_SEC));
    const totalFrames = info.dataLength / info.blockAlign;
    const count = Math.ceil(totalFrames / framesPerBlock);
    if (count === 0) {
      throw new Vid2ContextError('unsupported-input', `${audio.filename} has no samples.`, {
        hint: 'Pass audio with sound in it.',
      });
    }
    const frameAt = (i: number) => Math.min(totalFrames, i * framesPerBlock);
    const times = Array.from({ length: count + 1 }, (_, i) => frameAt(i) / info.sampleRate);
    const rms = blockRms(audio.data, info);
    const cuts = planCuts({
      count,
      times,
      bytesOf: (s, e) => HEADER_BYTES + (frameAt(e) - frameAt(s)) * info.blockAlign,
      maxBytes: opts.maxBytes,
      targetSec: opts.targetSec ?? 600,
      overlapSec: opts.overlapSec ?? 2,
      energy: (i) => rms[i] ?? 0,
      unit: 'block',
    });
    const base = baseName(audio);
    for (const [index, c] of cuts.entries()) {
      const from = info.dataOffset + frameAt(c.start) * info.blockAlign;
      const to = info.dataOffset + frameAt(c.end) * info.blockAlign;
      const data = new Uint8Array(HEADER_BYTES + (to - from));
      data.set(wavHeader(info, to - from), 0);
      data.set(audio.data.subarray(from, to), HEADER_BYTES);
      const durationSec = (times[c.end] as number) - (times[c.start] as number);
      const chunk: AudioChunk = {
        index,
        startSec: times[c.start] as number,
        durationSec,
        overlapSec: c.overlapSec,
        audio: { kind: 'bytes', data, mimeType: 'audio/wav', filename: `${base}-part${index + 1}.wav`, durationSec },
      };
      yield chunk;
    }
  },
};
