/**
 * Idle guard for answer streams. A stalled upstream (a socket that stays open
 * but sends nothing, or a stream that ignores its abort signal) must not
 * leave an answer spinning forever. Each next() races a timer that restarts
 * on every event; when it fires, the guard yields a `timeout` error event,
 * aborts the request and lets go of the inner stream without waiting for it.
 */
import type { ChatEvent } from './types.ts';

/** Seconds of silence before an answer is given up. Reasoning and text events both count as activity. */
export const STREAM_IDLE_MS = 60_000;

export async function* guardIdle(
  inner: AsyncIterable<ChatEvent>,
  opts: { idleMs?: number; abort?: () => void } = {},
): AsyncGenerator<ChatEvent> {
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS;
  const it = inner[Symbol.asyncIterator]();
  const TIMEOUT = Symbol('timeout');
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), idleMs);
      });
      const step = await Promise.race([it.next(), idle]).finally(() => clearTimeout(timer));
      if (step === TIMEOUT) {
        opts.abort?.();
        it.return?.().catch(() => {});
        yield {
          type: 'error',
          code: 'timeout',
          message: `No data from the model for ${Math.round(idleMs / 1000)} seconds.`,
          hint: 'The service stalled. Retry, or pick another model.',
        };
        return;
      }
      if (step.done) return;
      yield step.value;
      if (step.value.type === 'done' || step.value.type === 'error') return;
    }
  } finally {
    // Ends the inner stream when the consumer stops early; harmless when it already finished.
    it.return?.().catch(() => {});
  }
}
