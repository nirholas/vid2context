/**
 * Chrome's built-in Prompt API (the LanguageModel global, Gemini Nano on
 * device). One rung, enabled by CHROME_AI=1, which the web app sets after
 * detectBrowserAi() reports the API. Each request gets a fresh session seeded
 * with the conversation so far, and the session is destroyed afterwards.
 */
import {
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type Ctx,
  type Env,
  type StreamingLlmRung,
  Vid2ContextError,
} from '@vid2context/core';
import { type LanguageModelSession, languageModelGlobal, normalizeAvailability, PROMPT_API_IO } from './detect.ts';
import { emitProgress } from './progress.ts';

export const CHROME_AI_MODEL = 'prompt-api';

/** The window the last session reported, so later rungs(env) calls can show it. */
let reportedContextTokens: number | undefined;

export function sessionContextTokens(s: LanguageModelSession): number | undefined {
  const n = s.contextWindow ?? s.inputQuota;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Split a chat into the session's initial prompts and the final user turn to prompt with. */
export function splitForPromptApi(messages: ChatMessage[]): { initialPrompts: ChatMessage[]; input: string } {
  const last = messages.at(-1);
  if (last?.role !== 'user') {
    throw new Vid2ContextError('bad-request', 'chrome-ai: the last message must be from the user');
  }
  const head = messages.slice(0, -1);
  const system = head.filter((m) => m.role === 'system').map((m) => m.content);
  const turns = head.filter((m) => m.role !== 'system');
  const initialPrompts: ChatMessage[] = system.length ? [{ role: 'system', content: system.join('\n\n') }, ...turns] : turns;
  return { initialPrompts, input: last.content };
}

/**
 * Chrome releases before 137 streamed the whole answer so far in every chunk;
 * later ones stream only the new text. Return just the new part either way.
 */
export function newText(sofar: string, chunk: string): string {
  return sofar && chunk.startsWith(sofar) ? chunk.slice(sofar.length) : chunk;
}

/**
 * Chromium builds (not Chrome) expose the Prompt API without a model: sessions
 * open, then every answer is this notice followed by the prompt echoed back.
 * Observed in headless Chromium 159 on 2026-11-14.
 */
export const CHROMIUM_ECHO_NOTICE = 'On-device model is not available in Chromium';

/** True while `text` could still turn out to be the Chromium echo notice. */
function mayBeEcho(text: string): boolean {
  return text.length < CHROMIUM_ECHO_NOTICE.length && CHROMIUM_ECHO_NOTICE.startsWith(text);
}

function echoError(): Vid2ContextError {
  return new Vid2ContextError(
    'no-provider',
    'chrome-ai: this browser has the Prompt API but no on-device model (Chromium echoes the prompt)',
    {
      hint: 'Built-in AI needs Google Chrome, not Chromium. Pick another LLM.',
    },
  );
}

async function openSession(req: ChatRequest, initialPrompts: ChatMessage[], ctx: Ctx): Promise<LanguageModelSession> {
  const lm = languageModelGlobal();
  if (!lm) {
    throw new Vid2ContextError('no-provider', 'chrome-ai: the Prompt API is not available in this browser', {
      hint: 'It ships in desktop Chrome 148 and later on supported hardware. Pick another LLM.',
    });
  }
  const availability = normalizeAvailability(await lm.availability(PROMPT_API_IO));
  if (availability === 'unavailable') {
    throw new Vid2ContextError('no-provider', 'chrome-ai: this device cannot run Chrome built-in AI', {
      hint: 'It needs about 22 GB of free disk and a GPU with more than 4 GB of memory or 16 GB of RAM. Pick another LLM.',
    });
  }
  const options: Record<string, unknown> = {
    ...PROMPT_API_IO,
    initialPrompts,
    signal: ctx.signal,
    monitor(m: EventTarget) {
      m.addEventListener('downloadprogress', (e) => {
        const loaded = (e as Event & { loaded?: number }).loaded;
        emitProgress({ engine: 'chrome-ai', model: CHROME_AI_MODEL, progress: loaded, text: 'Downloading the on-device model' });
        ctx.log.info('chrome-ai: downloading the on-device model', { loaded });
      });
    },
  };
  // temperature and topK must be given together, and only where params() exists (extensions, or the sampling trial).
  if (req.temperature !== undefined && lm.params) {
    const params = await lm.params().catch(() => null);
    if (params) {
      options.temperature = Math.min(req.temperature, params.maxTemperature);
      options.topK = params.defaultTopK;
    }
  }
  try {
    const session = await lm.create(options);
    reportedContextTokens = sessionContextTokens(session) ?? reportedContextTokens;
    return session;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new Vid2ContextError('upstream', `chrome-ai: could not start a session: ${String((err as Error)?.message ?? err)}`, {
      cause: err,
      hint: 'The on-device model may still be downloading; try again in a few minutes, or pick another LLM.',
    });
  }
}

export function chromeAiRung(): StreamingLlmRung {
  const rung: StreamingLlmRung = {
    id: `llm/chrome-ai/${CHROME_AI_MODEL}`,
    provider: 'llm-browser',
    service: 'chrome-ai',
    model: CHROME_AI_MODEL,
    tier: 'local',
    priority: 50,
    quality: 2,
    capabilities: ['stream'],
    requires: ['CHROME_AI'],
    contextTokens: reportedContextTokens,
    isEnabled: (env: Env) => env.CHROME_AI === '1' || env.CHROME_AI?.toLowerCase() === 'true',
    async *stream(req: ChatRequest, ctx: Ctx): AsyncIterable<ChatStreamEvent> {
      const { initialPrompts, input } = splitForPromptApi(req.messages);
      const session = await openSession(req, initialPrompts, ctx);
      try {
        const reader = session.promptStreaming(input, { signal: ctx.signal }).getReader();
        let text = '';
        // Hold the first characters back until they cannot be the Chromium echo notice.
        let held = true;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const delta = newText(text, String(value));
            if (!delta) continue;
            text += delta;
            if (held) {
              if (mayBeEcho(text)) continue;
              if (text.startsWith(CHROMIUM_ECHO_NOTICE)) throw echoError();
              held = false;
              yield { type: 'delta', text };
              continue;
            }
            yield { type: 'delta', text: delta };
          }
          if (held && text) {
            if (text.startsWith(CHROMIUM_ECHO_NOTICE)) throw echoError();
            yield { type: 'delta', text };
          }
        } catch (err) {
          const e = err as Error & { contextWindow?: number; requested?: number };
          if (e?.name === 'QuotaExceededError') {
            throw new Vid2ContextError(
              'too-large',
              `chrome-ai: the prompt needs ${e.requested ?? '?'} tokens, the window is ${e.contextWindow ?? '?'}`,
              {
                cause: err,
                hint: 'Send a shorter excerpt, or pick an LLM with a larger context window.',
              },
            );
          }
          throw err;
        } finally {
          reader.releaseLock();
        }
        const used = session.contextUsage ?? session.inputUsage;
        yield {
          type: 'done',
          result: { text, model: CHROME_AI_MODEL, usage: used !== undefined ? { inputTokens: used } : undefined },
        };
      } finally {
        session.destroy();
      }
    },
    async chat(req: ChatRequest, ctx: Ctx): Promise<ChatResult> {
      for await (const e of rung.stream(req, ctx)) if (e.type === 'done') return e.result;
      throw new Vid2ContextError('upstream', 'chrome-ai: no result');
    },
  };
  return rung;
}
