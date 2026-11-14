import { describe, expect, it } from 'vitest';
import { chatEventsFromSse } from '../src/lib/api.ts';
import { guardIdle } from '../src/lib/idle.ts';
import type { ChatEvent } from '../src/lib/types.ts';
import { fixture } from './helpers.ts';

/** The recorded server stream, cut before `done`, followed by a socket that stays open and silent. */
function stalledStream(): ReadableStream<Uint8Array> {
  const raw = fixture('server-chat-cCPsdFdlshc.sse');
  const head = new TextEncoder().encode(raw.slice(0, raw.indexOf('event: done')));
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(head);
      }
      // Never enqueue again and never close: a stalled upstream.
      return new Promise<void>(() => {});
    },
  });
}

describe('guardIdle', () => {
  it('passes a real stream through untouched', async () => {
    const raw = fixture('server-chat-cCPsdFdlshc.sse');
    const body = new Response(raw).body as ReadableStream<Uint8Array>;
    const out: ChatEvent[] = [];
    for await (const ev of guardIdle(chatEventsFromSse(body), { idleMs: 1000 })) out.push(ev);
    expect(out.map((e) => e.type)).toEqual(['meta', 'delta', 'done']);
  });

  it('gives up on a stalled stream with a timeout error and aborts it', async () => {
    let aborted = false;
    const out: ChatEvent[] = [];
    for await (const ev of guardIdle(chatEventsFromSse(stalledStream()), { idleMs: 200, abort: () => (aborted = true) }))
      out.push(ev);
    expect(out.map((e) => e.type)).toEqual(['meta', 'delta', 'error']);
    expect(out.at(-1)).toMatchObject({ code: 'timeout', hint: expect.stringMatching(/Retry/) });
    expect(aborted).toBe(true);
  });
});
