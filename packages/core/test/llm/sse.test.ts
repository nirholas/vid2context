import { describe, expect, it } from 'vitest';
import { parseSSE, type SseMessage } from '../../src/llm/sse.ts';
import { chunked, recording, STREAMS } from './fixtures.ts';

async function collect(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of parseSSE(stream, signal)) out.push(m);
  return out;
}

/** Every byte boundary in the first 512 bytes, every boundary inside a multi-byte character, and a stride across the rest. */
function samplePositions(bytes: Uint8Array): number[] {
  const pos = new Set<number>();
  for (let i = 1; i < Math.min(512, bytes.length); i++) pos.add(i);
  for (let i = 1; i < bytes.length; i++) {
    // A continuation byte (10xxxxxx): cutting before it splits a character.
    if (((bytes[i] as number) & 0xc0) === 0x80) pos.add(i);
  }
  for (let i = 512; i < bytes.length; i += 97) pos.add(i);
  return [...pos];
}

describe('parseSSE on real recorded streams', () => {
  for (const name of STREAMS) {
    it(`${name}: identical events however the bytes are split`, async () => {
      const rec = recording(name);
      const whole = await collect(chunked(rec.body, []));
      expect(whole.length).toBeGreaterThan(5);
      expect(whole.at(-1)?.data).toBe('[DONE]');
      for (const p of samplePositions(rec.body)) {
        expect(await collect(chunked(rec.body, [p]))).toEqual(whole);
      }
      // One byte at a time.
      const every = Array.from({ length: rec.body.length }, (_, i) => i);
      expect(await collect(chunked(rec.body, every))).toEqual(whole);
    });
  }

  it('splits inside multi-byte characters without corrupting them', async () => {
    const rec = recording('pollinations-openai-fast.japanese.stream');
    const cuts: number[] = [];
    for (let i = 1; i < rec.body.length; i++) if (((rec.body[i] as number) & 0xc0) === 0x80) cuts.push(i);
    expect(cuts.length).toBeGreaterThan(10);
    const events = await collect(chunked(rec.body, cuts));
    const text = events.map((e) => e.data).join('');
    expect(text).toContain('人類');
    expect(text).not.toContain('�');
  });

  it('skips comment lines (OVH keepalives)', async () => {
    const rec = recording('ovh-llama-3.3-70b.stream');
    const raw = new TextDecoder().decode(rec.body);
    expect(raw.startsWith(':')).toBe(true);
    const events = await collect(chunked(rec.body, []));
    const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).length;
    expect(events).toHaveLength(dataLines);
    expect(events.every((e) => e.data !== '')).toBe(true);
  });

  it('reads CRLF line endings the same as LF', async () => {
    const rec = recording('ovh-gpt-oss-120b.stream');
    const crlf = new TextEncoder().encode(new TextDecoder().decode(rec.body).replaceAll('\n', '\r\n'));
    const whole = await collect(chunked(rec.body, []));
    // Cut between every CR and its LF too.
    const cuts: number[] = [];
    for (let i = 0; i < crlf.length; i++) if (crlf[i] === 13) cuts.push(i + 1);
    expect(await collect(chunked(crlf, cuts))).toEqual(whole);
  });

  it('keeps a final event that has no blank line after it', async () => {
    const rec = recording('ovh-llama-3.3-70b.stream');
    const whole = await collect(chunked(rec.body, []));
    const trimmed = new TextEncoder().encode(new TextDecoder().decode(rec.body).replace(/\n+$/, ''));
    expect(await collect(chunked(trimmed, []))).toEqual(whole);
  });

  it('joins multi-line data with newlines', async () => {
    // Two real events from the recording, merged into one event by removing the blank line between them.
    const rec = recording('ovh-llama-3.3-70b.stream');
    const lines = new TextDecoder()
      .decode(rec.body)
      .split('\n')
      .filter((l) => l.startsWith('data: {'));
    const merged = new TextEncoder().encode(`${lines[0]}\n${lines[1]}\n\n`);
    const events = await collect(chunked(merged, [7]));
    expect(events).toEqual([{ data: `${lines[0]?.slice(6)}\n${lines[1]?.slice(6)}` }]);
  });

  it('stops with the abort reason when the signal fires', async () => {
    const rec = recording('ovh-gpt-oss-120b.stream');
    const controller = new AbortController();
    const seen: SseMessage[] = [];
    const run = async () => {
      for await (const m of parseSSE(chunked(rec.body, [200, 400, 600, 800]), controller.signal)) {
        seen.push(m);
        controller.abort(new DOMException('stop', 'AbortError'));
      }
    };
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(1);
  });
});
