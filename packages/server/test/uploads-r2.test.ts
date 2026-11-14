/**
 * Uploads on the Cloudflare storage backend: real workerd D1, R2 and KV from
 * Miniflare, through the real CloudflareStorage. Bytes go to R2 and the
 * upload's details to KV, so a second app (another Worker isolate) can
 * transcribe an upload the first one received.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, type Storage, type VideoContext } from '@vid2context/core';
import { createCloudflareStorage } from '@vid2context/provider-storage-cloudflare';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APOLLO_MP3, makeApp, OVH_URL } from './helpers.ts';

const mp3 = new Uint8Array(readFileSync(APOLLO_MP3));
const sha = createHash('sha256').update(mp3).digest('hex');

let mf: Miniflare;
let bindings: Record<string, unknown>;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'vid2context-server-uploads', DB2: 'vid2context-server-uploads-2' },
      r2Buckets: ['MEDIA'],
      kvNamespaces: ['KV', 'KV2'],
    }),
  );
  bindings = await mf.getBindings();
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

async function cloudflareStorage(withR2: boolean): Promise<Storage> {
  const env = withR2
    ? { VID2CONTEXT_D1: 'DB', VID2CONTEXT_KV: 'KV', VID2CONTEXT_R2: 'MEDIA' }
    : { VID2CONTEXT_D1: 'DB2', VID2CONTEXT_KV: 'KV2' };
  return createCloudflareStorage(createContext({ runtime: 'workers', env, bindings }));
}

function form(): FormData {
  const f = new FormData();
  f.append('file', new Blob([mp3 as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' }), 'apollo11-small-step.mp3');
  return f;
}

describe('uploads on Cloudflare storage', () => {
  it('stores bytes in R2 and details in KV, so another isolate can transcribe the upload', async () => {
    const storage = await cloudflareStorage(true);
    const first = makeApp({ storage });
    const res = await first.app.request('/api/v1/uploads', { method: 'POST', body: form() });
    expect(res.status).toBe(201);
    expect((await res.json()).input).toBe(`upload:${sha}`);

    const bucket = bindings.MEDIA as { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> };
    const object = await bucket.get(`blobs/uploads/${sha}`);
    expect(object).not.toBeNull();
    expect(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(mp3);

    // A second app shares only the storage, like a second Worker isolate.
    const second = makeApp({ storage });
    const ctxRes = await second.app.request(`/api/v1/context?url=upload:${sha}`);
    expect(ctxRes.status).toBe(200);
    const context = (await ctxRes.json()) as VideoContext;
    expect(context.metadata.title).toBe('apollo11-small-step');
    expect(context.transcript.segments.at(-1)?.text.trim()).toBe("That's one small step for man, one giant leap for mankind.");
    expect(second.fetch.calls.filter((c) => c.url === OVH_URL)).toHaveLength(1);

    // A third isolate reuses the transcript saved in KV instead of transcribing again.
    const third = makeApp({ storage });
    expect((await third.app.request(`/api/v1/transcript?url=upload:${sha}`)).status).toBe(200);
    expect(third.fetch.calls).toHaveLength(0);
  }, 60_000);

  it('keeps uploads in memory when no R2 bucket is bound', async () => {
    const storage = await cloudflareStorage(false);
    const { app } = makeApp({ storage });
    expect((await app.request('/api/v1/uploads', { method: 'POST', body: form() })).status).toBe(201);
    expect((await app.request(`/api/v1/metadata?url=upload:${sha}`)).status).toBe(200);
    const other = makeApp({ storage });
    const missing = await other.app.request(`/api/v1/metadata?url=upload:${sha}`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.hint).toContain('in memory');
  }, 60_000);
});
