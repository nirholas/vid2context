/**
 * Runtime-neutral core of the Transformers.js Whisper rungs. No Node built-ins
 * and no DOM-only code here: src/node.ts and src/browser.ts each supply the
 * audio decoder and model cache for their runtime, and the package's
 * conditional exports pick the right one ("browser" for bundlers that target
 * the browser, the Node entry everywhere else).
 *
 * Transformers.js is imported lazily on the first transcription, so loading
 * the registry never pulls in onnxruntime when the rung is disabled.
 */
import {
  type Ctx,
  defineProvider,
  type Env,
  type Runtime,
  type Segment,
  type SttOptions,
  type SttProvider,
  type SttResult,
  type SttRung,
  Vid2ContextError,
  type AudioInput,
} from '@vid2context/core';

/** Repo on the Hugging Face Hub that publishes the Whisper ONNX exports. */
export const MODEL_ORG = 'onnx-community';
/** Default: small, multilingual, about 80 MB quantized; fine on CPU and WASM. */
export const DEFAULT_MODEL = `${MODEL_ORG}/whisper-base`;
/** Recommended on WebGPU or a fast CPU: much better accuracy, about 1 GB of weights. */
export const TURBO_MODEL = `${MODEL_ORG}/whisper-large-v3-turbo`;

export const SAMPLE_RATE = 16_000;
/** Chunked long-form inference: 30 s windows with 5 s of overlap on each side. */
export const CHUNK_LENGTH_S = 30;
export const STRIDE_LENGTH_S = 5;

export type TransformersDevice = 'cpu' | 'cuda' | 'dml' | 'coreml' | 'wasm' | 'webgpu';
const NODE_DEVICES: TransformersDevice[] = ['cpu', 'cuda', 'dml', 'coreml', 'webgpu'];
const BROWSER_DEVICES: TransformersDevice[] = ['wasm', 'webgpu'];

/** Options a caller may add on top of core SttOptions. */
export interface TransformersSttOptions extends SttOptions {
  /** Whisper task: 'transcribe' (default) keeps the spoken language, 'translate' outputs English. */
  task?: 'transcribe' | 'translate';
}

/** The automatic-speech-recognition pipeline output with `return_timestamps: true`. */
export interface PipelineOutput {
  text: string;
  chunks?: { timestamp: [number | null, number | null]; text: string }[];
}

/** A Transformers.js download progress event, as passed to `progress_callback`. */
export type ProgressEvent = { status: string; name?: string; file?: string; progress?: number; loaded?: number; total?: number; [k: string]: unknown };

const listeners = new Set<(e: ProgressEvent) => void>();

/** Subscribe to model download and load progress (the web app shows this). Returns an unsubscribe function. */
export function onProgress(listener: (e: ProgressEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Expand a short name ('whisper-small') to its onnx-community repo id. */
export function resolveModelId(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes('/') ? trimmed : `${MODEL_ORG}/${trimmed}`;
}

export function modelsFromEnv(env: Env): string[] {
  const raw = env.TRANSFORMERS_STT_MODEL?.trim();
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean).map(resolveModelId))];
}

const isEnglishOnly = (model: string) => /\.en$/i.test(model);
/** large-v3-turbo was fine-tuned without translation data, so it cannot translate. */
const canTranslate = (model: string) => !isEnglishOnly(model) && !/turbo/i.test(model);

function qualityOf(model: string): number {
  if (/large|turbo/i.test(model)) return 4;
  if (/medium|small/i.test(model)) return 3;
  return 2;
}

/**
 * Pick the inference device. An explicit TRANSFORMERS_DEVICE wins when it is
 * valid for the runtime. Otherwise: CPU (onnxruntime-node) in Node; WebGPU in
 * the browser when an adapter was obtained, WASM when not.
 */
export function chooseDevice(runtime: Runtime, override: string | undefined, webgpuWorks: boolean): TransformersDevice {
  const allowed = runtime === 'browser' ? BROWSER_DEVICES : NODE_DEVICES;
  const want = override?.trim().toLowerCase();
  if (want && want !== 'auto') {
    if (!allowed.includes(want as TransformersDevice)) {
      throw new Vid2ContextError('bad-request', `TRANSFORMERS_DEVICE=${want} is not supported on ${runtime}`, {
        hint: `Use one of: auto, ${allowed.join(', ')}.`,
      });
    }
    return want as TransformersDevice;
  }
  if (runtime === 'browser') return webgpuWorks ? 'webgpu' : 'wasm';
  return 'cpu';
}

/**
 * Weight precision per device: 8-bit quantized weights on CPU and WASM (small
 * and fast), full-precision encoder with a 4-bit decoder on GPUs (the encoder
 * is sensitive to quantization; the decoder runs once per token).
 */
export function chooseDtype(device: TransformersDevice): string | Record<string, string> {
  if (device === 'webgpu' || device === 'cuda' || device === 'dml') {
    return { encoder_model: 'fp32', decoder_model_merged: 'q4' };
  }
  return 'q8';
}

/**
 * Map pipeline chunks to Segments. Transformers.js already resolves the 30 s
 * windows into absolute times; this trims text, drops empty chunks, fills a
 * missing end (the last chunk often has none) from the next start or the
 * audio duration, and keeps times monotonic so overlap glitches never move
 * backwards.
 */
export function mapChunks(output: PipelineOutput, durationSec: number): Segment[] {
  const chunks = output.chunks ?? [];
  if (chunks.length === 0) {
    const text = output.text.trim();
    return text ? [{ startSec: 0, endSec: round(durationSec), text }] : [];
  }
  const segments: Segment[] = [];
  let floor = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const text = chunk.text.trim();
    if (!text) continue;
    const [rawStart, rawEnd] = chunk.timestamp;
    const nextStart = chunks.slice(i + 1).find((c) => c.timestamp[0] !== null)?.timestamp[0] ?? null;
    let start = Math.max(rawStart ?? floor, floor);
    if (durationSec > 0) start = Math.min(start, durationSec);
    let end = rawEnd ?? nextStart ?? durationSec;
    if (durationSec > 0) end = Math.min(end, durationSec);
    if (end < start) end = start;
    segments.push({ startSec: round(start), endSec: round(end), text });
    floor = end;
  }
  return segments;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** What a runtime entry supplies to build the provider. */
export interface RuntimeHooks {
  runtime: Runtime;
  /** Decode any audio to 16 kHz mono float samples. */
  decode(audio: AudioInput, ctx: Ctx): Promise<Float32Array>;
  /** Where downloaded models live: a directory in Node, null in the browser (Cache Storage). */
  cacheDir(ctx: Ctx): string | null;
  /** True when WebGPU is present and an adapter can be obtained. */
  webgpuWorks(): Promise<boolean>;
}

type Transformers = typeof import('@huggingface/transformers');
type AsrPipeline = Awaited<ReturnType<Transformers['pipeline']>> & {
  (audio: Float32Array, opts: Record<string, unknown>): Promise<PipelineOutput>;
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: {
    generation_config: { decoder_start_token_id: number; lang_to_id?: Record<string, number> };
    generate(opts: Record<string, unknown>): Promise<{ tolist(): (number | bigint)[][] }>;
  };
};

let transformersModule: Promise<Transformers> | undefined;
const pipelines = new Map<string, Promise<AsrPipeline>>();

function emit(ctx: Ctx, model: string, e: ProgressEvent, state: { lastPct: number }) {
  for (const l of listeners) l(e);
  if (e.status === 'progress_total' && typeof e.progress === 'number') {
    const pct = Math.floor(e.progress / 10) * 10;
    if (pct > state.lastPct) {
      state.lastPct = pct;
      ctx.log.info(`transformers: downloading ${model} ${pct}%`, { loaded: e.loaded, total: e.total });
    }
  } else if (e.status === 'ready') {
    ctx.log.info(`transformers: ${model} ready`);
  }
}

async function loadPipeline(hooks: RuntimeHooks, model: string, device: TransformersDevice, ctx: Ctx): Promise<AsrPipeline> {
  const dtype = chooseDtype(device);
  const key = `${model}|${device}|${JSON.stringify(dtype)}`;
  let p = pipelines.get(key);
  if (!p) {
    p = (async () => {
      transformersModule ??= import('@huggingface/transformers');
      const tf = await transformersModule;
      const dir = hooks.cacheDir(ctx);
      tf.env.allowLocalModels = false;
      tf.env.fetch = ctx.fetch;
      if (dir) {
        tf.env.cacheDir = dir;
        tf.env.useFSCache = true;
      } else {
        tf.env.useBrowserCache = true;
      }
      const state = { lastPct: -1 };
      ctx.log.info(`transformers: loading ${model} on ${device}`, { cacheDir: dir ?? 'browser Cache Storage' });
      const pipe = await tf.pipeline('automatic-speech-recognition', model, {
        device,
        dtype: dtype as never,
        progress_callback: (e: unknown) => emit(ctx, model, e as ProgressEvent, state),
      });
      return pipe as unknown as AsrPipeline;
    })();
    pipelines.set(key, p);
    p.catch(() => pipelines.delete(key));
  }
  try {
    return await p;
  } catch (err) {
    if (err instanceof Vid2ContextError) throw err;
    throw new Vid2ContextError('upstream', `transformers: could not load ${model} on ${device}: ${String((err as Error)?.message ?? err)}`, {
      cause: err,
      hint: 'The first run downloads the model from huggingface.co. Check the network, the model id in TRANSFORMERS_STT_MODEL, or set TRANSFORMERS_DEVICE=wasm (browser) or cpu (Node).',
    });
  }
}

/**
 * Whisper's own language identification: one decoder step after the
 * start-of-transcript token over the first 30 s, with every token except the
 * language tokens masked out. Transformers.js would otherwise assume English.
 */
async function detectLanguage(tf: Transformers, pipe: AsrPipeline, audio: Float32Array): Promise<string | undefined> {
  const gc = pipe.model.generation_config;
  const langToId = gc.lang_to_id;
  if (!langToId) return undefined;
  const allowed = new Set(Object.values(langToId));
  class LanguageOnly extends tf.LogitsProcessor {
    override _call(inputIds: bigint[][], logits: unknown) {
      const rows = logits as unknown as { data: Float32Array }[];
      for (let i = 0; i < inputIds.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const data = row.data;
        for (let t = 0; t < data.length; t++) if (!allowed.has(t)) data[t] = Number.NEGATIVE_INFINITY;
      }
      return logits;
    }
  }
  const processors = new tf.LogitsProcessorList();
  processors.push(new LanguageOnly());
  const { input_features } = await pipe.processor(audio.subarray(0, SAMPLE_RATE * CHUNK_LENGTH_S));
  const out = await pipe.model.generate({
    inputs: input_features,
    decoder_input_ids: [gc.decoder_start_token_id],
    max_new_tokens: 1,
    logits_processor: processors,
  });
  const seq = (out as unknown as { sequences?: { tolist(): (number | bigint)[][] } }).sequences ?? out;
  const id = Number(seq.tolist()[0]?.at(-1));
  const token = Object.entries(langToId).find(([, v]) => v === id)?.[0];
  return token?.replace(/^<\|/, '').replace(/\|>$/, '');
}

/** Run the full transcription on decoded samples. Exported for the demo pages. */
export async function transcribeSamples(
  hooks: RuntimeHooks,
  model: string,
  samples: Float32Array,
  opts: TransformersSttOptions,
  ctx: Ctx,
): Promise<SttResult & { device: TransformersDevice; raw: PipelineOutput }> {
  const device = chooseDevice(hooks.runtime, ctx.env.TRANSFORMERS_DEVICE, hooks.runtime === 'browser' ? await hooks.webgpuWorks() : false);
  const pipe = await loadPipeline(hooks, model, device, ctx);
  const tf = await (transformersModule as Promise<Transformers>);
  const durationSec = samples.length / SAMPLE_RATE;
  const task = opts.task ?? 'transcribe';
  if (task === 'translate' && !canTranslate(model)) {
    throw new Vid2ContextError('upstream', `transformers: ${model} cannot translate`, {
      hint: 'Use a multilingual non-turbo model for translation, such as whisper-small or whisper-base.',
    });
  }
  let language = opts.language?.split('-')[0]?.toLowerCase();
  if (isEnglishOnly(model)) language = 'en';
  else if (!language) language = (await detectLanguage(tf, pipe, samples)) ?? 'en';
  const raw = await pipe(samples, {
    return_timestamps: true,
    chunk_length_s: CHUNK_LENGTH_S,
    stride_length_s: STRIDE_LENGTH_S,
    ...(isEnglishOnly(model) ? {} : { language, task }),
  });
  if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
  return {
    language: task === 'translate' ? 'en' : language,
    segments: mapChunks(raw, durationSec),
    model,
    device,
    raw,
  };
}

/** Build the provider for one runtime. */
export function createTransformersProvider(hooks: RuntimeHooks): SttProvider {
  return defineProvider({
    id: 'stt-transformers',
    kind: 'stt',
    name: 'Whisper on Transformers.js (offline)',
    runtimes: ['node', 'browser'],
    rungs(env: Env): SttRung[] {
      const configured = modelsFromEnv(env);
      const models = configured.length ? configured : [DEFAULT_MODEL];
      return models.map(
        (model, i): SttRung => ({
          id: `stt/transformers/${model}`,
          provider: 'stt-transformers',
          service: 'transformers',
          model,
          tier: 'local',
          priority: 30 + i,
          quality: qualityOf(model),
          capabilities: isEnglishOnly(model)
            ? ['segments']
            : ['segments', 'language-detect', ...(canTranslate(model) ? ['translate'] : [])],
          requires: ['TRANSFORMERS_STT_MODEL'],
          isEnabled: (e) => modelsFromEnv(e).includes(model),
          async transcribe(audio: AudioInput, opts: SttOptions, ctx: Ctx): Promise<SttResult> {
            const samples = await hooks.decode(audio, ctx);
            if (samples.length === 0) {
              throw new Vid2ContextError('upstream', 'transformers: the audio decoded to zero samples', {
                hint: 'The file has no audio track or is not a supported format.',
              });
            }
            const { language, segments } = await transcribeSamples(hooks, model, samples, opts, ctx);
            return { language, segments, model };
          },
        }),
      );
    },
  });
}
