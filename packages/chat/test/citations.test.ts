import { describe, expect, it } from 'vitest';
import { chipLabel, citationsFromText, citationsToLinks, citedNumbers, splitCitations } from '../src/lib/citations.ts';
import type { ChatEvent } from '../src/lib/types.ts';
import { clientRecording, fixture } from './helpers.ts';

function serverEvents() {
  const raw = fixture('server-chat-cCPsdFdlshc.sse');
  const blocks = raw.split('\n\n').filter(Boolean);
  return blocks.map((b) => {
    const event = /event: (.*)/.exec(b)?.[1];
    const data = JSON.parse(/data: (.*)/.exec(b)?.[1] ?? '{}');
    return { type: event, ...data } as ChatEvent;
  });
}

describe('[n] markers in real answers', () => {
  it('finds the citations the server reported', () => {
    const events = serverEvents();
    const done = events.find((e) => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>;
    expect(citedNumbers(done.text)).toEqual(done.citations.map((c) => c.n));
  });

  it('reads gpt-oss lenticular markers like 【2】', () => {
    const rec = clientRecording('ovh-gpt-oss');
    const done = rec.events.find((e) => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>;
    const meta = rec.events.find((e) => e.type === 'meta') as Extract<ChatEvent, { type: 'meta' }>;
    expect(done.text).toMatch(/【\d+】/);
    expect(citationsFromText(done.text, meta.sources)).toEqual(done.citations);
    expect(done.citations.length).toBeGreaterThan(0);
  });

  it('splits lists and ranges, and leaves links and footnotes alone', () => {
    const parts = splitCitations('A [1, 3] B [2-4] C [7](https://x.test) D [^1] E 【5†L1-L4】.');
    const cites = parts.filter((p) => p.kind === 'cite').map((p) => (p.kind === 'cite' ? p.ns : []));
    expect(cites).toEqual([[1, 3], [2, 3, 4], [5]]);
    expect(parts.map((p) => (p.kind === 'text' ? p.text : p.raw)).join('')).toBe(
      'A [1, 3] B [2-4] C [7](https://x.test) D [^1] E 【5†L1-L4】.',
    );
  });

  it('labels chips "Title @ m:ss" from meta.sources', () => {
    const meta = serverEvents()[0] as Extract<ChatEvent, { type: 'meta' }>;
    const second = meta.sources[1];
    if (!second) throw new Error('fixture has sources');
    expect(chipLabel(second)).toBe('Best & Worst G-Wagon Years: Rel… @ 1:09');
    expect(chipLabel(second, 200)).toBe('Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked! @ 1:09');
  });

  it('turns markers into timestamp links for Markdown export', () => {
    const meta = serverEvents()[0] as Extract<ChatEvent, { type: 'meta' }>;
    const md = citationsToLinks('Reliable [2].', meta.sources);
    expect(md).toBe(
      'Reliable [Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked! @ 1:09](https://www.youtube.com/watch?v=cCPsdFdlshc&t=69s).',
    );
    expect(citationsToLinks('Unknown [99].', meta.sources)).toBe('Unknown [99].');
  });
});
