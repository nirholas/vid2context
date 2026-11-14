/**
 * Browser entry: decodes audio with Web Audio (OfflineAudioContext resamples
 * to 16 kHz), runs on WebGPU when an adapter is available and WASM otherwise,
 * and caches models in the browser's Cache Storage. No Node built-ins.
 */
import { type AudioInput, type Ctx, errorFromResponse, Vid2ContextError } from '@vid2context/core';
import { createTransformersProvider, type RuntimeHooks, SAMPLE_RATE } from './index.ts';

export * from './index.ts';

interface GpuNavigator {
  gpu?: { requestAdapter(): Promise<unknown | null> };
}

let webgpu: Promise<boolean> | undefined;

/** True when navigator.gpu exists and hands out an adapter. Cached per page. */
export function webgpuWorks(): Promise<boolean> {
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

/** Decode with Web Audio and mix down to 16 kHz mono. */
export async function decodeWithWebAudio(audio: AudioInput, ctx: Ctx): Promise<Float32Array> {
  let bytes: ArrayBuffer;
  if (audio.kind === 'bytes') {
    bytes = audio.data.slice().buffer as ArrayBuffer;
  } else {
    const res = await ctx.fetch(audio.url, { signal: ctx.signal });
    if (!res.ok) throw await errorFromResponse(res, 'transformers: audio download');
    bytes = await res.arrayBuffer();
  }
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Vid2ContextError('no-provider', 'transformers: Web Audio is not available in this browser', {
      hint: 'Use a current Chrome, Edge, Firefox or Safari.',
    });
  }
  const ac = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: SAMPLE_RATE });
  let buffer: AudioBuffer;
  try {
    buffer = await ac.decodeAudioData(bytes);
  } catch (err) {
    throw new Vid2ContextError('upstream', 'transformers: the browser could not decode this audio', {
      cause: err,
      hint: 'Try an mp3, m4a, wav, ogg or webm file.',
    });
  }
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] = (mono[i] ?? 0) + (ch[i] ?? 0) / buffer.numberOfChannels;
  }
  return mono;
}

export const browserHooks: RuntimeHooks = {
  runtime: 'browser',
  decode: decodeWithWebAudio,
  cacheDir: () => null,
  webgpuWorks,
};

const provider = createTransformersProvider(browserHooks);
export default provider;
