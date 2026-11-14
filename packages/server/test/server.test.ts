import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { createRegistry } from '@vid2context/registry/node';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

// Real recordings from providers/youtube/test/fixtures.
const read = (p: string) => readFileSync(join(import.meta.dirname, '../../../providers/youtube/test/fixtures', p), 'utf8');

const fetch = replayFetch([
  {
    method: 'POST',
    url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    response: (call) => {
      const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
      return { body: read(`player-${videoId === 'jNQXAC9IVRw' ? videoId : 'unavailable'}.json`) };
    },
  },
  { url: /timedtext\?v=jNQXAC9IVRw.*lang=en/, response: { body: read('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
]);

const env = { GROQ_API_KEY: 'gsk_secret_value' };
const app = createApp({ registry: createRegistry(), makeCtx: () => testContext({ fetch, env }) });

describe('HTTP API', () => {
  it('reports providers and rungs without secret values', async () => {
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.providers.map((p: { id: string }) => p.id)).toContain('youtube');
    const groq = body.providers
      .flatMap((p: { rungs?: { id: string; enabled: boolean }[] }) => p.rungs ?? [])
      .find((r: { id: string }) => r.id === 'stt/groq/whisper-large-v3-turbo');
    expect(groq).toMatchObject({ enabled: true, requires: ['GROQ_API_KEY'] });
    expect(JSON.stringify(body)).not.toContain('gsk_secret_value');
  });

  it('serves the context as JSON and the transcript in a chosen format', async () => {
    const ctxRes = await app.request('/api/v1/context?url=https%3A%2F%2Fyoutu.be%2FjNQXAC9IVRw');
    expect(ctxRes.status).toBe(200);
    expect((await ctxRes.json()).metadata.title).toBe('Me at the zoo');
    const t = await app.request('/api/v1/transcript?url=jNQXAC9IVRw&timestamps=1');
    expect(t.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect((await t.text()).split('\n')[0]).toBe('[0:01] All right, so here we are, in front of the elephants');
  });

  it('maps errors to statuses with code, hint and attempts', async () => {
    const missing = await app.request('/api/v1/transcript');
    expect(missing.status).toBe(400);
    const gone = await app.request('/api/v1/context?url=xxxxxxxxxxx');
    expect(gone.status).toBe(404);
    const body = await gone.json();
    expect(body.error).toMatchObject({ code: 'not-found' });
    expect(body.attempts.length).toBeGreaterThan(0);
    expect((await app.request('/api/v1/transcript?url=jNQXAC9IVRw&format=pdf')).status).toBe(400);
  });
});
