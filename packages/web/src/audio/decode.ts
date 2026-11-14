/**
 * Turn any audio or video file the browser can play into 16 kHz mono samples
 * with Web Audio: `decodeAudioData` decodes, then an `OfflineAudioContext`
 * with one 16 kHz channel downmixes and resamples. Speech models (Whisper and
 * every hosted speech-to-text API) work at 16 kHz mono, so nothing they use
 * is lost.
 */
import { Vid2ContextError } from '@vid2context/core';

export const TARGET_RATE = 16_000;

/** File.arrayBuffer and decodeAudioData both need the whole file in memory. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

const MEDIA_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|ogg|oga|opus|flac|weba|webm|mp4|m4v|mov|mkv|3gp|3g2|aif|aiff|caf|amr)$/i;
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|ogg|oga|opus|flac|weba|aif|aiff|caf|amr)$/i;

export function isMediaFile(file: { name: string; type: string }): boolean {
  return /^(audio|video)\//.test(file.type) || MEDIA_EXT.test(file.name);
}

export function isAudioOnly(file: { name: string; type: string }): boolean {
  return file.type.startsWith('audio/') || (!file.type.startsWith('video/') && AUDIO_EXT.test(file.name));
}

/** Throws a clear error for files the app will not try to decode. */
export function checkFile(file: { name: string; type: string; size: number }): void {
  if (!isMediaFile(file)) {
    throw new Vid2ContextError('unsupported-input', `"${file.name}" is not an audio or video file.`, {
      hint: 'Drop an audio or video file such as mp3, m4a, wav, ogg, webm, mp4 or mov.',
    });
  }
  if (file.size === 0) {
    throw new Vid2ContextError('unsupported-input', `"${file.name}" is empty.`, { hint: 'Pick the file again; it has 0 bytes.' });
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Vid2ContextError('too-large', `"${file.name}" is larger than 2 GB, too large to convert in a browser.`, {
      hint: 'Use the CLI on your machine instead: npm run cli -- /path/to/file',
    });
  }
}

export interface Decoded {
  /** 16 kHz mono samples. */
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  /** Channels in the source before the downmix. */
  sourceChannels: number;
}

export async function decodeToMono16k(bytes: ArrayBuffer, filename = 'file'): Promise<Decoded> {
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Vid2ContextError('no-provider', 'This browser has no Web Audio support, so it cannot convert files.', {
      hint: 'Use a current Chrome, Edge, Firefox or Safari.',
    });
  }
  // Decoding into a 16 kHz context resamples while decoding, which keeps an
  // hour of stereo audio near 460 MB instead of 1.4 GB at 48 kHz.
  const decoder = new OfflineAudioContext(1, 1, TARGET_RATE);
  let buffer: AudioBuffer;
  try {
    buffer = await decoder.decodeAudioData(bytes);
  } catch (err) {
    throw new Vid2ContextError('unsupported-input', `The browser could not decode the audio in "${filename}".`, {
      hint: 'The file may have no audio track or use a codec this browser lacks. Try mp3, m4a, wav, ogg, webm or mp4, or convert it first with: ffmpeg -i input -ac 1 -ar 16000 output.wav',
      cause: err,
    });
  }
  if (buffer.length === 0 || buffer.duration === 0) {
    throw new Vid2ContextError('unsupported-input', `"${filename}" has no audio.`, {
      hint: 'Pick a file with a sound track.',
    });
  }
  const length = Math.max(1, Math.ceil(buffer.duration * TARGET_RATE));
  const mixer = new OfflineAudioContext(1, length, TARGET_RATE);
  const source = mixer.createBufferSource();
  source.buffer = buffer;
  source.connect(mixer.destination);
  source.start();
  const rendered = await mixer.startRendering();
  return {
    samples: rendered.getChannelData(0),
    sampleRate: rendered.sampleRate,
    durationSec: rendered.length / rendered.sampleRate,
    sourceChannels: buffer.numberOfChannels,
  };
}

/** Read a file with progress events (File.arrayBuffer has none). */
export function readFile(file: Blob, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () =>
      reject(
        new Vid2ContextError('unsupported-input', 'The browser could not read the file.', {
          hint: 'Check that the file still exists and that the browser may read it, then pick it again.',
          cause: reader.error,
        }),
      );
    reader.onabort = () => reject(new DOMException('Reading canceled', 'AbortError'));
    signal?.addEventListener('abort', () => reader.abort(), { once: true });
    reader.readAsArrayBuffer(file);
  });
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as ArrayBuffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
