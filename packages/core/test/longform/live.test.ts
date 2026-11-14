/**
 * Live: a 35-minute public-domain LibriVox chapter, downloaded by URL and
 * transcribed end to end through whatever STT rungs the environment enables
 * (with no keys, the keyless OVH lane alone). Slow on keyless: OVH allows
 * about 2 requests per minute and 60 s of audio per request.
 *
 *   LIVE=1 npx vitest run packages/core/test/longform/live.test.ts
 */
import { createContext, MemoryKv, Registry, stderrLogger, transcribeLong } from '@vid2context/core';
import sttProvider from '@vid2context/provider-stt-openai-compatible';
import { describe, expect, it } from 'vitest';
import { fileRef } from './helpers.ts';

const URL_35_MIN =
  'https://archive.org/download/chancellorsville_gettysburg_ms_librivox/chancellorsvillegettysburg_07_doubleday_64kb.mp3';

describe.skipIf(!process.env.LIVE)('transcribeLong live', () => {
  it(
    'transcribes a 35-minute MP3 end to end',
    async () => {
      const ctx = createContext({ runtime: 'node', env: process.env, fetch: globalThis.fetch, log: stderrLogger('info') });
      const started = Date.now();
      const res = await transcribeLong(
        new Registry([sttProvider], 'node'),
        fileRef('doubleday-ch07'),
        { kind: 'url', url: URL_35_MIN, mimeType: 'audio/mpeg' },
        {
          kv: new MemoryKv(),
          rateLimitWaitMs: 30 * 60_000,
          onProgress: (p) => process.stderr.write(`progress ${p.done}/${p.total}: ${p.message ?? ''}\n`),
        },
        ctx,
      );
      const segs = res.transcript.segments;
      const rungs = [
        ...new Set(
          res.attempts.filter((a) => a.stage === 'stt' && a.outcome === 'ok' && a.id.startsWith('stt/')).map((a) => a.id),
        ),
      ];
      const pieces = res.attempts.filter((a) => a.outcome === 'ok' && a.id.startsWith('stt/') && a.reason !== 'resumed').length;
      const seams = res.attempts.filter((a) => a.id === 'longform/stitch').map((a) => a.reason);
      process.stderr.write(
        `${JSON.stringify({
          audioSec: segs.at(-1)?.endSec,
          chunks: res.chunks,
          requestsOk: pieces,
          wallSec: Math.round((Date.now() - started) / 1000),
          rungs,
          seams: Object.fromEntries([...new Set(seams)].map((m) => [m, seams.filter((x) => x === m).length])),
          segments: segs.length,
          words: segs.reduce((n, s) => n + s.text.split(/\s+/).length, 0),
        })}\n`,
      );
      expect(res.transcript.language).toBe('en');
      expect(segs.at(-1)?.endSec).toBeGreaterThan(30 * 60);
      for (let i = 1; i < segs.length; i++) expect(segs[i]?.startSec).toBeGreaterThanOrEqual(segs[i - 1]?.startSec as number);
    },
    90 * 60_000,
  );
});
