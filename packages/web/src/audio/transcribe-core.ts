/**
 * The in-browser speech-to-text run itself: the browser registry's
 * speech-to-text chain on 16 kHz mono WAV, with the user's own keys from
 * Settings as env. The Transformers.js Whisper rung (local tier) runs first;
 * it downloads its model from huggingface.co once and caches it in the
 * browser's Cache Storage. Rungs for hosted services join the chain only when
 * their key is saved in Settings.
 *
 * No DOM here: transcribe.worker.ts runs this in a Web Worker so a long file
 * never freezes the page, and local.ts falls back to running it on the main
 * thread when a module worker cannot start.
 *
 * Workers have no Web Audio, so the Whisper rung is built here with hooks
 * that read the app's 16 kHz PCM WAV directly (pcm.ts) and use Web Audio only
 * for anything else, where it exists. The rest of the browser registry is
 * used as is.
 */
import { type Attempt, type AudioInput, Registry, transcribe, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { DEFAULT_MODEL, onProgress, type ProgressEvent } from '@vid2context/provider-stt-transformers';
import { createTransformersProvider, type RuntimeHooks } from '@vid2context/provider-stt-transformers/shared';
import { createBrowserContext, providers } from '@vid2context/registry/browser';
import { localRefOf } from './local-ref.ts';
import { decodePcmWav } from './pcm.ts';

interface GpuNavigator {
  gpu?: { requestAdapter(): Promise<unknown | null> };
}

let webgpu: Promise<boolean> | undefined;

/** True when navigator.gpu exists (pages and workers) and hands out an adapter. Asked once. */
function webgpuWorks(): Promise<boolean> {
  webgpu ??= (async () => {
    const gpu = (globalThis.navigator as (Navigator & GpuNavigator) | undefined)?.gpu;
    if (!gpu) return false;
    try {
      return (await gpu.requestAdapter()) !== null;
    } catch {
      return false;
    }
  })();
  return webgpu;
}

async function decode(audio: AudioInput): Promise<Float32Array> {
  if (audio.kind === 'bytes') {
    const samples = decodePcmWav(audio.data);
    if (samples) return samples;
    if (typeof OfflineAudioContext !== 'undefined') {
      const { decodeToMono16k } = await import('./decode.ts');
      return (await decodeToMono16k(audio.data.slice().buffer as ArrayBuffer)).samples;
    }
  }
  throw new Vid2ContextError('unsupported-input', 'transformers: only 16 kHz PCM WAV can be read here', {
    hint: 'The app converts files before transcribing; pick the file again.',
  });
}

const hooks: RuntimeHooks = { runtime: 'browser', decode, cacheDir: () => null, webgpuWorks };
const whisper = createTransformersProvider(hooks);

/** The browser registry with the Whisper rung above in place of the one that needs Web Audio. */
function createRegistry(): Registry {
  return new Registry(
    providers.map((p) => (p.id === whisper.id ? whisper : p)),
    'browser',
  );
}

export interface ModelProgress {
  /** 0..100 when known. */
  percent?: number;
  status: string;
  file?: string;
}

/** What a transcription needs from a prepared file: plain data, so it can be posted to a worker. */
export interface LocalAudio {
  sha256: string;
  /** The original file name, shown as the title. */
  name: string;
  sampleRate: number;
  durationSec: number;
  /** 16-bit mono WAV. */
  wav: Uint8Array;
}

export interface LocalOptions {
  lang?: string;
  keys: Record<string, string>;
  decodeMs: number;
}

export async function transcribeLocal(
  audio: LocalAudio,
  opts: LocalOptions & { onModel?: (p: ModelProgress) => void },
  signal?: AbortSignal,
): Promise<VideoContext> {
  const env = { TRANSFORMERS_STT_MODEL: DEFAULT_MODEL, ...opts.keys };
  const ctx = createBrowserContext(env, signal);
  const registry = createRegistry();
  const ref = localRefOf(audio);
  const off = onProgress((e: ProgressEvent) => {
    if (e.status === 'progress_total' || e.status === 'progress') {
      opts.onModel?.({ status: 'downloading', percent: typeof e.progress === 'number' ? e.progress : undefined, file: e.file });
    } else if (e.status === 'ready') {
      opts.onModel?.({ status: 'ready' });
    }
  });
  const decodeAttempt: Attempt = {
    id: 'web/decode',
    stage: 'audio',
    outcome: 'ok',
    detail: `decoded in the browser to ${audio.sampleRate} Hz mono, ${audio.durationSec.toFixed(1)} s`,
    ms: opts.decodeMs,
  };
  try {
    const { transcript, attempts } = await transcribe(
      registry,
      ref,
      {
        kind: 'bytes',
        data: audio.wav,
        mimeType: 'audio/wav',
        filename: `${audio.sha256}.wav`,
        durationSec: audio.durationSec,
      },
      { stt: opts.lang ? { language: opts.lang } : {} },
      ctx,
    );
    return {
      metadata: { ref, title: audio.name, durationSec: audio.durationSec, chapters: [] },
      transcript,
      attempts: [decodeAttempt, ...attempts],
    };
  } catch (err) {
    const tried = (err as { attempts?: Attempt[] }).attempts ?? [];
    throw Object.assign(err as object, { attempts: [decodeAttempt, ...tried] });
  } finally {
    off();
  }
}
