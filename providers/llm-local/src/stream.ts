/**
 * Helpers shared by the Ollama and OpenAI-compatible streams: reading a
 * response body line by line with an idle timeout, and routing inline
 * <think> blocks (Qwen3, DeepSeek R1 distills) to reasoning events so they
 * never reach the answer text, even when a tag is split across chunks.
 */
import { type Ctx, Vid2ContextError } from '@vid2context/core';

/**
 * POST and return the response once headers arrive. The timeout covers the
 * wait for the first byte and every gap between chunks after that, so a long
 * generation that keeps producing tokens is never cut off, but a stuck server
 * is. Call `done()` when finished reading.
 */
export async function openStream(
  ctx: Ctx,
  url: string,
  init: RequestInit,
  idleMs: number,
): Promise<{ res: Response; touch: () => void; done: () => void; signal: AbortSignal }> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => ctrl.abort(new Vid2ContextError('timeout', `No data from ${new URL(url).host} for ${idleMs / 1000} s.`)),
      idleMs,
    );
  };
  const done = () => {
    if (timer) clearTimeout(timer);
  };
  const signal = ctx.signal ? AbortSignal.any([ctrl.signal, ctx.signal]) : ctrl.signal;
  touch();
  try {
    const res = await ctx.fetch(url, { ...init, signal });
    touch();
    return { res, touch, done, signal };
  } catch (err) {
    done();
    throw signal.aborted && signal.reason instanceof Vid2ContextError ? signal.reason : err;
  }
}

/** Yield complete lines (without the newline) from a streamed body. */
export async function* readLines(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk();
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        yield buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    }
    buf += decoder.decode();
    if (buf) yield buf.replace(/\r$/, '');
  } finally {
    reader.releaseLock();
  }
}

const OPEN = '<think>';
const CLOSE = '</think>';

/** Splits streamed text into answer and reasoning parts around <think>...</think>. */
export class ThinkSplitter {
  private inThink = false;
  private pending = '';

  /** Feed a chunk; returns the parts that are certain so far. */
  push(chunk: string): { answer: string; reasoning: string } {
    let text = this.pending + chunk;
    this.pending = '';
    let answer = '';
    let reasoning = '';
    while (text) {
      const tag = this.inThink ? CLOSE : OPEN;
      const at = text.indexOf(tag);
      if (at !== -1) {
        if (this.inThink) reasoning += text.slice(0, at);
        else answer += text.slice(0, at);
        text = text.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // Hold back a suffix that could be the start of the tag.
      let keep = 0;
      for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
        if (tag.startsWith(text.slice(-n))) {
          keep = n;
          break;
        }
      }
      const out = text.slice(0, text.length - keep);
      this.pending = text.slice(text.length - keep);
      if (this.inThink) reasoning += out;
      else answer += out;
      text = '';
    }
    return { answer, reasoning };
  }

  /** Flush whatever was held back at the end of the stream. */
  end(): { answer: string; reasoning: string } {
    const rest = this.pending;
    this.pending = '';
    return this.inThink ? { answer: '', reasoning: rest } : { answer: rest, reasoning: '' };
  }
}
