/**
 * WebLLM rungs: small instruct models compiled for WebGPU by MLC, running in
 * the page. WEBLLM_MODEL (comma-separated prebuilt model ids) selects them,
 * one rung each. The engine is loaded lazily on the first request and kept
 * per model for the life of the page; weights are cached by the browser.
 */
import {
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type Ctx,
  type Env,
  type LlmRung,
  type StreamingLlmRung,
  Vid2ContextError,
} from '@vid2context/core';
import { emitProgress } from './progress.ts';

/**
 * Small instruct models from WebLLM's prebuilt list (checked against
 * @mlc-ai/web-llm 0.2.88), smallest first. q4f16 builds need the WebGPU
 * 'shader-f16' feature; q4f32 builds run everywhere WebGPU does. VRAM figures
 * are WebLLM's own: about 0.9, 1.6 and 2.3 GB for the f16 builds.
 */
const F16 = ['Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', 'Llama-3.2-3B-Instruct-q4f16_1-MLC'];
const F32 = ['Llama-3.2-1B-Instruct-q4f32_1-MLC', 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', 'Llama-3.2-3B-Instruct-q4f32_1-MLC'];

/** The smallest prebuilt instruct model (about 0.4 GB with f16 shaders, 0.6 GB without), used by the live browser test. */
export function smallestWebLlmModel(shaderF16: boolean): string {
  return shaderF16 ? 'SmolLM2-360M-Instruct-q4f16_1-MLC' : 'SmolLM2-360M-Instruct-q4f32_1-MLC';
}
/** Every prebuilt model in this list has a 4096-token context window. */
export const WEBLLM_CONTEXT_TOKENS = 4096;

export function recommendedWebLlmModels(shaderF16: boolean): string[] {
  return shaderF16 ? [...F16] : [...F32];
}

export function webLlmModelsFromEnv(env: Env): string[] {
  const raw = env.WEBLLM_MODEL?.trim();
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function qualityOf(model: string): number {
  const m = /(\d+(?:\.\d+)?)B/i.exec(model);
  const billions = m ? Number(m[1]) : 1;
  return billions >= 3 ? 3 : billions >= 1.5 ? 2 : 1;
}

type WebLlm = typeof import('@mlc-ai/web-llm');
type Engine = Awaited<ReturnType<WebLlm['CreateMLCEngine']>>;

const engines = new Map<string, Promise<Engine>>();
/** WebLLM runs one generation at a time per engine; requests queue here. */
const queues = new Map<string, Promise<unknown>>();

async function engineFor(model: string, ctx: Ctx): Promise<Engine> {
  if (!(globalThis.navigator as Navigator & { gpu?: unknown })?.gpu) {
    throw new Vid2ContextError('no-provider', 'webllm: WebGPU is not available in this browser', {
      hint: 'Use a current Chrome or Edge with WebGPU enabled, or pick another LLM.',
    });
  }
  let p = engines.get(model);
  if (!p) {
    p = (async () => {
      const webllm = await import('@mlc-ai/web-llm');
      ctx.log.info(`webllm: loading ${model}`);
      let lastPct = -1;
      return await webllm.CreateMLCEngine(model, {
        initProgressCallback: (r) => {
          emitProgress({ engine: 'webllm', model, progress: r.progress, text: r.text });
          const pct = Math.floor(r.progress * 10) * 10;
          if (pct > lastPct) {
            lastPct = pct;
            ctx.log.info(`webllm: ${model} ${pct}%`, { text: r.text });
          }
        },
      });
    })();
    engines.set(model, p);
    p.catch(() => engines.delete(model));
  }
  try {
    return await p;
  } catch (err) {
    throw new Vid2ContextError('upstream', `webllm: could not load ${model}: ${String((err as Error)?.message ?? err)}`, {
      cause: err,
      hint: 'Check the model id in WEBLLM_MODEL against the WebLLM prebuilt list, free GPU memory, or pick a smaller model.',
    });
  }
}

/** WebLLM accepts one leading system message; merge any others into it. */
export function toWebLlmMessages(messages: ChatMessage[]): ChatMessage[] {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length === 0 || rest.at(-1)?.role !== 'user') {
    throw new Vid2ContextError('bad-request', 'webllm: the last message must be from the user');
  }
  return system.length ? [{ role: 'system', content: system.join('\n\n') }, ...rest] : rest;
}

/** Run one generation at a time per model. The slot is taken on first iteration and freed when the stream ends or is abandoned. */
function serialize<T>(model: string, run: () => AsyncGenerator<T>): AsyncGenerator<T> {
  return (async function* () {
    const prev = queues.get(model) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((r) => {
      release = r;
    });
    queues.set(
      model,
      prev.then(() => mine),
    );
    await prev;
    try {
      yield* run();
    } finally {
      release();
    }
  })();
}

export function webLlmRung(model: string, index: number): StreamingLlmRung {
  const rung: StreamingLlmRung = {
    id: `llm/webllm/${model}`,
    provider: 'llm-browser',
    service: 'webllm',
    model,
    tier: 'local',
    priority: 40 + index,
    quality: qualityOf(model),
    capabilities: ['stream'],
    requires: ['WEBLLM_MODEL'],
    contextTokens: WEBLLM_CONTEXT_TOKENS,
    isEnabled: (env) => webLlmModelsFromEnv(env).includes(model),
    stream(req: ChatRequest, ctx: Ctx): AsyncIterable<ChatStreamEvent> {
      return serialize(model, async function* () {
        const messages = toWebLlmMessages(req.messages);
        const engine = await engineFor(model, ctx);
        const onAbort = () => engine.interruptGenerate();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const chunks = await engine.chat.completions.create({
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          });
          let text = '';
          let usage: ChatResult['usage'];
          for await (const chunk of chunks) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              text += delta;
              yield { type: 'delta', text: delta } as const;
            }
            if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
          }
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
          yield { type: 'done', result: { text, model, usage } } as const;
        } finally {
          ctx.signal?.removeEventListener('abort', onAbort);
        }
      });
    },
    async chat(req: ChatRequest, ctx: Ctx): Promise<ChatResult> {
      for await (const e of rung.stream(req, ctx)) if (e.type === 'done') return e.result;
      throw new Vid2ContextError('upstream', `webllm: ${model} returned no result`);
    },
  };
  return rung;
}

export function webLlmRungs(env: Env): LlmRung[] {
  const configured = webLlmModelsFromEnv(env);
  const models = configured.length ? configured : recommendedWebLlmModels(true);
  return models.map((m, i) => webLlmRung(m, i));
}
