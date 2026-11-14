import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { APOLLO_MP3, makeApp, OVH_URL, seededStorage } from './helpers.ts';

const mp3 = new Uint8Array(readFileSync(APOLLO_MP3));
const sha = createHash('sha256').update(mp3).digest('hex');

function form(bytes: Uint8Array, filename: string, type = 'audio/mpeg'): FormData {
  const f = new FormData();
  f.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), filename);
  return f;
}

/** File names in a zip, read from its central directory headers. */
function zipNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const names: string[] = [];
  for (let i = 0; i + 46 <= zip.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const len = view.getUint16(i + 28, true);
    names.push(new TextDecoder().decode(zip.subarray(i + 46, i + 46 + len)));
  }
  return names;
}

describe('uploads', () => {
  it('stores a multipart upload by sha256 and transcribes it through the speech-to-text chain', async () => {
    const { app, fetch } = makeApp();
    const res = await app.request('/api/v1/uploads', { method: 'POST', body: form(mp3, 'apollo11-small-step.mp3') });
    expect(res.status).toBe(201);
    const upload = await res.json();
    expect(upload).toMatchObject({
      input: `upload:${sha}`,
      filename: 'apollo11-small-step.mp3',
      bytes: mp3.byteLength,
      mimeType: 'audio/mpeg',
    });
    expect(Date.parse(upload.expiresAt) - Date.now()).toBeGreaterThan(59 * 60_000);

    const ctxRes = await app.request(`/api/v1/context?url=${encodeURIComponent(upload.input)}`);
    expect(ctxRes.status).toBe(200);
    const context = (await ctxRes.json()) as VideoContext;
    expect(context.metadata).toMatchObject({ title: 'apollo11-small-step', ref: { id: `upload:${sha}`, platform: 'upload' } });
    expect(context.transcript).toMatchObject({ origin: 'stt', producer: 'stt/ovh/whisper-large-v3-turbo', language: 'en' });
    expect(context.transcript.segments.map((s) => s.text.trim())).toEqual([
      "I'm going to step off the limb now.",
      "That's one small step for man, one giant leap for mankind.",
    ]);
    expect(context.attempts[0]).toMatchObject({ id: 'uploads', stage: 'resolve', outcome: 'ok' });
    expect(fetch.calls.filter((c) => c.url === OVH_URL)).toHaveLength(1);

    // Transcribed once: later routes reuse the result while the upload lives.
    const text = await (await app.request(`/api/v1/transcript?url=upload:${sha}`)).text();
    expect(text).toContain('one giant leap for mankind');
    expect(fetch.calls.filter((c) => c.url === OVH_URL)).toHaveLength(1);

    // Uploads never enter the library.
    expect((await (await app.request('/api/v1/library')).json()).items).toEqual([]);
    expect((await app.request(`/api/v1/metadata?url=upload:${sha}`)).status).toBe(200);
  });

  it('gives 413 for uploads over VID2CONTEXT_MAX_UPLOAD_MB, and clear errors for bad requests', async () => {
    const { app } = makeApp({ env: { VID2CONTEXT_MAX_UPLOAD_MB: '1' } });
    // Eight copies of the real recording: about 1.16 MB.
    const big = new Uint8Array(mp3.byteLength * 8);
    for (let i = 0; i < 8; i++) big.set(mp3, i * mp3.byteLength);
    const tooBig = await app.request('/api/v1/uploads', { method: 'POST', body: form(big, 'long.mp3') });
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toMatchObject({ code: 'too-large', hint: expect.stringContaining('audio') });

    const json = await app.request('/api/v1/uploads', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(json.status).toBe(400);
    const noFile = new FormData();
    noFile.append('other', 'x');
    expect((await app.request('/api/v1/uploads', { method: 'POST', body: noFile })).status).toBe(400);

    expect((await app.request('/api/v1/context?url=upload:1234')).status).toBe(400);
    const expired = await app.request(`/api/v1/context?url=upload:${'0'.repeat(64)}`);
    expect(expired.status).toBe(404);
    expect((await expired.json()).error.hint).toContain('Upload the file again');
  });

  it('refuses caption and video modes for uploads, which only have audio', async () => {
    const { app } = makeApp();
    await app.request('/api/v1/uploads', { method: 'POST', body: form(mp3, 'apollo.mp3') });
    const res = await app.request(`/api/v1/context?url=upload:${sha}&mode=captions`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('unsupported-input');
  });
});

describe('bundle', () => {
  it('streams a zip for one video with Content-Disposition', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v1/bundle?url=jNQXAC9IVRw&formats=text,srt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="me-at-the-zoo.zip"');
    const zip = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(zip.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const names = zipNames(zip);
    expect(names).toEqual(
      expect.arrayContaining([
        'me-at-the-zoo/context.md',
        'me-at-the-zoo/transcript.txt',
        'me-at-the-zoo/transcript.srt',
        'me-at-the-zoo/manifest.json',
      ]),
    );
    expect(names).not.toContain('me-at-the-zoo/transcript.vtt');
    expect((await app.request('/api/v1/bundle?url=jNQXAC9IVRw&formats=pdf')).status).toBe(400);
  });

  it('bundles a collection with POST', async () => {
    const { storage, collectionId } = await seededStorage();
    const { app, fetch } = makeApp({ storage });
    const res = await app.request('/api/v1/bundle', {
      method: 'POST',
      body: JSON.stringify({ collectionId, formats: ['markdown'] }),
    });
    expect(res.status).toBe(200);
    const names = zipNames(new Uint8Array(await res.arrayBuffer()));
    expect(names).toEqual(
      expect.arrayContaining([
        'vid2context-2-videos/index.md',
        'vid2context-2-videos/llms.txt',
        'vid2context-2-videos/context.md',
      ]),
    );
    expect(names.filter((n) => n.endsWith('/transcript.md'))).toHaveLength(2);
    expect(fetch.calls).toHaveLength(0);
  });
});
