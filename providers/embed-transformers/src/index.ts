/**
 * Local embeddings with Transformers.js: nothing leaves the machine and no
 * server is needed. onnxruntime-node on the CPU in Node, WebGPU in browsers
 * that have it, with a WASM fallback.
 *
 * Enabled by TRANSFORMERS_EMBED_MODEL (a Hugging Face model id with ONNX
 * weights). The recommended model is Xenova/multilingual-e5-small: 384
 * dimensions, about 100 languages, a 118 MB quantized download, and about
 * 50 ms for 8 sentences on one CPU core (measured 2026-11-14). It ranked every
 * paraphrase pair from a real transcript above every unrelated pair;
 * paraphrase-multilingual-MiniLM-L12-v2 did not, and bge-small-en-v1.5 is
 * English only.
 *
 * The model loads lazily on the first call and is reused. On Node it is
 * cached under .vid2context/models (or $VID2CONTEXT_HOME/models); browsers
 * use the Cache API.
 */
import { type Ctx, defineProvider, type EmbedProvider, type Env, Vid2ContextError } from '@vid2context/core';
import { type EmbedMode, makeEmbedRung, modelInfo, type RetrievalEmbedRung } from '@vid2context/provider-embed';

export const PROVIDER_ID = 'embed-transformers';
export const RECOMMENDED_MODEL = 'Xenova/multilingual-e5-small';
/** Quantized 8-bit weights on every device, so vectors match between Node and the browser. */
export const DTYPE = 'q8';

/** The part of a Transformers.js Tensor we read: shape [n, dims] and flat values. */
export interface TensorLike {
  dims: number[];
  data: ArrayLike<number>;
}

type Extractor = (texts: string[], opts: { pooling: 'mean' | 'cls'; normalize: boolean }) => Promise<TensorLike>;

/** Split a [n, dims] tensor into n vectors. */
export function toVectors(t: TensorLike): number[][] {
  const [n, d] = t.dims;
  if (t.dims.length !== 2 || !n || !d || t.data.length !== n * d) {
    throw new Vid2ContextError('upstream', `Unexpected embedding tensor shape [${t.dims.join(', ')}].`);
  }
  const out: number[][] = [];
  for (let i = 0; i < n; i++) out.push(Array.from({ length: d }, (_, j) => t.data[i * d + j] as number));
  return out;
}

/** bge models are trained with CLS pooling; e5, MiniLM and gte with mean pooling. */
export function poolingFor(model: string): 'mean' | 'cls' {
  return /bge-/i.test(model) ? 'cls' : 'mean';
}

const loaded = new Map<string, Promise<Extractor>>();

function hasWebGpu(): boolean {
  return Boolean((globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu);
}

async function load(model: string, ctx: Ctx): Promise<Extractor> {
  const { pipeline } = await import('@huggingface/transformers');
  const cacheDir =
    ctx.runtime === 'node' ? `${(ctx.env.VID2CONTEXT_HOME || '.vid2context').replace(/\/+$/, '')}/models` : undefined;
  const devices: ('cpu' | 'webgpu' | 'wasm')[] = ctx.runtime === 'node' ? ['cpu'] : hasWebGpu() ? ['webgpu', 'wasm'] : ['wasm'];
  let lastErr: unknown;
  for (const device of devices) {
    try {
      ctx.log.info('loading local embedding model', { model, device });
      const ex = await pipeline('feature-extraction', model, {
        device,
        dtype: DTYPE,
        ...(cacheDir ? { cache_dir: cacheDir } : {}),
      });
      return ex as unknown as Extractor;
    } catch (err) {
      lastErr = err;
      ctx.log.warn('could not load the embedding model on this device', { model, device });
    }
  }
  throw new Vid2ContextError('unavailable', `Could not load ${model} with Transformers.js: ${String(lastErr)}`.slice(0, 500), {
    cause: lastErr,
    hint: `Check that TRANSFORMERS_EMBED_MODEL names a Hugging Face model with ONNX weights (for example ${RECOMMENDED_MODEL}) and that the first run can download it.`,
  });
}

function extractor(model: string, ctx: Ctx): Promise<Extractor> {
  const key = `${ctx.runtime}:${model}`;
  let p = loaded.get(key);
  if (!p) {
    p = load(model, ctx);
    // A failed load is not cached, so the next call can try again.
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return p;
}

export function transformersEmbedRungs(env: Env): RetrievalEmbedRung[] {
  const configured = (env.TRANSFORMERS_EMBED_MODEL ?? '').trim();
  const model = configured || RECOMMENDED_MODEL;
  const info = modelInfo(model);
  const pooling = poolingFor(model);
  return [
    makeEmbedRung({
      id: `embed/transformers/${model}`,
      provider: PROVIDER_ID,
      service: 'transformers',
      model,
      tier: 'local',
      priority: 40,
      quality: info.quality,
      requires: ['TRANSFORMERS_EMBED_MODEL'],
      enabled: Boolean(configured),
      dimensions: info.dimensions,
      maxInputTokens: info.maxInputTokens,
      maxBatch: 16,
      embedBatch: async (texts: string[], _mode: EmbedMode, ctx: Ctx) => {
        const ex = await extractor(model, ctx);
        return toVectors(await ex(texts, { pooling, normalize: true }));
      },
    }),
  ];
}

const provider: EmbedProvider = defineProvider({
  id: PROVIDER_ID,
  kind: 'embed',
  name: 'Transformers.js local embeddings',
  runtimes: ['node', 'browser'],
  rungs: transformersEmbedRungs,
});

export default provider;
