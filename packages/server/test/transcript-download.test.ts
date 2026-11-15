/**
 * GET /api/v1/transcript as a file download (download=1) and with the
 * caption opt-outs auto=0 and translated=0. Real YouTube recordings only.
 */
import { describe, expect, it } from 'vitest';
import { attachment } from '../src/http-util.ts';
import { calls, makeApp } from './helpers.ts';

describe('transcript downloads', () => {
  it('download=1 names the file <title>.<lang>.<extension> with the format content type', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v1/transcript?url=jNQXAC9IVRw&mode=captions&format=srt&download=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-subrip; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Me at the zoo.en.srt"');
    expect(await res.text()).toMatch(/^1\n00:00:01,/);

    const vtt = await app.request('/api/v1/transcript?url=jNQXAC9IVRw&format=vtt&download=1');
    expect(vtt.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    expect(vtt.headers.get('content-disposition')).toBe('attachment; filename="Me at the zoo.en.vtt"');
  });

  it('uses the language of the transcript it sends, and sends no Content-Disposition without download=1', async () => {
    const { app } = makeApp();
    const de = await app.request('/api/v1/transcript?url=jNQXAC9IVRw&mode=captions&lang=de&download=1');
    expect(de.headers.get('content-disposition')).toBe('attachment; filename="Me at the zoo.de.txt"');
    const inline = await app.request('/api/v1/transcript?url=jNQXAC9IVRw');
    expect(inline.headers.get('content-disposition')).toBeNull();
  });

  it('adds an RFC 5987 filename* for names outside ASCII and strips path and control characters', () => {
    expect(attachment('Café: déjà vu.fr.srt')).toBe(
      `attachment; filename="Cafe deja vu.fr.srt"; filename*=UTF-8''Caf%C3%A9%20d%C3%A9j%C3%A0%20vu.fr.srt`,
    );
    expect(attachment('東京.ja.vtt')).toBe(`attachment; filename="_.ja.vtt"; filename*=UTF-8''%E6%9D%B1%E4%BA%AC.ja.vtt`);
    expect(attachment('../a/b\\c"d\u0007.en.srt')).toBe('attachment; filename="a b c d.en.srt"');
    expect(attachment("100% (it's) done.en.srt")).toBe(
      `attachment; filename="100_ (it's) done.en.srt"; filename*=UTF-8''100%25%20%28it%27s%29%20done.en.srt`,
    );
  });
});

describe('caption opt-outs', () => {
  it('auto=0 refuses auto-captions; without it the auto track is served', async () => {
    const refused = makeApp();
    const res = await refused.app.request('/api/v1/transcript?url=cCPsdFdlshc&mode=captions&auto=0');
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('no-transcript');

    const { app } = makeApp();
    expect((await app.request('/api/v1/transcript?url=cCPsdFdlshc&mode=captions')).status).toBe(200);
  });

  it("translated=0 refuses the platform's machine translation into lang, without asking for it", async () => {
    const { app, fetch } = makeApp();
    const res = await app.request('/api/v1/transcript?url=jNQXAC9IVRw&mode=captions&lang=fr&translated=0');
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('no-transcript');
    expect(calls(fetch, /tlang=fr/)).toBe(0);
  });
});
