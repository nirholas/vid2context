import { describe, expect, it } from 'vitest';
import { chatEventsFromSse } from '../src/lib/api.ts';
import { parseSse } from '../src/lib/sse.ts';
import type { ChatEvent } from '../src/lib/types.ts';
import { chunkedStream, clientRecording, fixture } from './helpers.ts';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('parseSse on the real /api/v1/chat stream', () => {
  const raw = fixture('server-chat-cCPsdFdlshc.sse');

  it('yields the same events whatever the chunk boundaries', async () => {
    const whole = await collect(parseSse(chunkedStream(raw, raw.length)));
    for (const size of [1, 3, 7, 64, 1000]) {
      expect(await collect(parseSse(chunkedStream(raw, size)))).toEqual(whole);
    }
    expect(whole.map((m) => m.event)).toEqual(['meta', 'delta', 'done']);
  });

  it('handles CRLF line endings split across chunks', async () => {
    const crlf = raw.replace(/\n/g, '\r\n');
    const lf = await collect(parseSse(chunkedStream(raw, 50)));
    for (const size of [1, 2, 5]) expect(await collect(parseSse(chunkedStream(crlf, size)))).toEqual(lf);
  });

  it('decodes the chat events of SHARED-CONTRACTS section 3', async () => {
    const events = await collect(chatEventsFromSse(chunkedStream(raw, 17)));
    const meta = events[0] as Extract<ChatEvent, { type: 'meta' }>;
    expect(meta.type).toBe('meta');
    expect(meta.rung).toBe('llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(meta.sources.length).toBeGreaterThan(5);
    expect(meta.sources[0]).toMatchObject({ n: 1, videoId: 'youtube:cCPsdFdlshc', startSec: 0 });
    expect(meta.promptTokens).toBe(6103);
    const done = events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.citations.map((c) => c.n)).toEqual([1, 2]);
    expect(done.attempts.map((a) => a.outcome)).toEqual(['error', 'ok']);
    const text = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(done.text).toContain(text.trim().slice(0, 40));
  });

  it('reports a stream that ends before done', async () => {
    const cut = raw.slice(0, raw.indexOf('event: done'));
    const events = await collect(chatEventsFromSse(chunkedStream(cut, 40)));
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'upstream' });
  });
});

describe('parseSse on a real OpenAI-compatible stream (OVH)', () => {
  it('reads every data line of the recorded body', async () => {
    const body = clientRecording('ovh-gpt-oss').responses[0]?.body ?? '';
    const messages = await collect(parseSse(chunkedStream(body, 128)));
    const expected = body.split(/\n\n/).filter((b) => b.startsWith('data:')).length;
    expect(messages.length).toBe(expected);
    expect(messages.every((m) => m.event === 'message')).toBe(true);
    expect(JSON.parse(messages[0]?.data ?? '{}').model).toBe('gpt-oss-120b');
  });
});
