/**
 * From a dropped file to something to send: read, decode, downmix and
 * resample to 16 kHz mono, encode as 16-bit WAV. When the file is audio-only
 * and already smaller than that WAV (a compressed mp3 or m4a usually is), the
 * original is sent instead; video files always shrink to the WAV.
 */
import { checkFile, decodeToMono16k, isAudioOnly, readFile, sha256Hex } from './decode.ts';
import { encodeWav } from './wav.ts';

export type PrepareStage =
  | { stage: 'reading'; loaded: number; total: number }
  | { stage: 'decoding' }
  | { stage: 'encoding' };

export interface Prepared {
  file: File;
  /** sha256 of the original file. */
  sha256: string;
  durationSec: number;
  sampleRate: number;
  sourceChannels: number;
  samples: Float32Array;
  wav: Uint8Array;
  /** What to upload: the WAV, or the original when it is smaller audio. */
  upload: { blob: Blob; filename: string; kind: 'wav' | 'original'; bytes: number };
}

export function wavName(filename: string): string {
  const base = filename.replace(/\.[^./\\]+$/, '') || 'audio';
  return `${base}.wav`;
}

export async function prepareFile(file: File, onStage: (s: PrepareStage) => void, signal?: AbortSignal): Promise<Prepared> {
  checkFile(file);
  onStage({ stage: 'reading', loaded: 0, total: file.size });
  const bytes = await readFile(file, (loaded, total) => onStage({ stage: 'reading', loaded, total }), signal);
  const sha256 = await sha256Hex(bytes);
  signal?.throwIfAborted();
  onStage({ stage: 'decoding' });
  // decodeAudioData detaches its buffer in some browsers; the hash is taken first.
  const decoded = await decodeToMono16k(bytes, file.name);
  signal?.throwIfAborted();
  onStage({ stage: 'encoding' });
  const wav = encodeWav(decoded.samples, decoded.sampleRate);
  const useOriginal = isAudioOnly(file) && file.size <= wav.length;
  const upload = useOriginal
    ? { blob: file as Blob, filename: file.name, kind: 'original' as const, bytes: file.size }
    : {
        blob: new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }),
        filename: wavName(file.name),
        kind: 'wav' as const,
        bytes: wav.length,
      };
  return {
    file,
    sha256,
    durationSec: decoded.durationSec,
    sampleRate: decoded.sampleRate,
    sourceChannels: decoded.sourceChannels,
    samples: decoded.samples,
    wav,
    upload,
  };
}
