/**
 * The Captions page's .zip, in Node (jsdom's Blob has no stream()), on the
 * real tracks recorded from the API (test/fixtures/README.md, captions-*).
 */
import { describe, expect, it } from 'vitest';
import { zipCaptions } from '../src/lib/captions.ts';
import { recorded } from './helpers.ts';

const text = (name: string) => recorded(name).body as string;

describe('captions .zip', () => {
  it('zips several tracks into one archive', async () => {
    const blob = await zipCaptions([
      { name: 'Me at the zoo.en.srt', text: text('captions-transcript-en-srt.json') },
      { name: 'Me at the zoo.de.vtt', text: text('captions-transcript-de-vtt.json') },
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(blob.type).toBe('application/zip');
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe('PK');
    const raw = new TextDecoder('latin1').decode(bytes);
    expect(raw).toContain('Me at the zoo.en.srt');
    expect(raw).toContain('Me at the zoo.de.vtt');
  });
});
