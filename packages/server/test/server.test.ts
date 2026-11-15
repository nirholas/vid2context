import type { VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { calls, makeApp, seededStorage, sharedContext } from './helpers.ts';

const ZOO = 'https%3A%2F%2Fyoutu.be%2FjNQXAC9IVRw';

describe('health, formats and errors', () => {
  it('reports providers and rungs without secret values', async () => {
    const { app } = makeApp({ env: { GROQ_API_KEY: 'gsk_secret_value' } });
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

  it('lists formats with extensions', async () => {
    const { app } = makeApp();
    const body = await (await app.request('/api/v1/formats')).json();
    const ids = body.formats.map((f: { id: string }) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['text', 'json', 'markdown', 'srt', 'vtt', 'pack']));
    expect(body.formats.find((f: { id: string }) => f.id === 'srt')).toMatchObject({ extension: 'srt' });
  });

  it('maps every failure class to its status with the standard body', async () => {
    const { app } = makeApp();
    const missing = await app.request('/api/v1/transcript');
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'bad-request', hint: expect.any(String) }, attempts: [] });

    const gone = await app.request('/api/v1/context?url=xxxxxxxxxxx');
    expect(gone.status).toBe(404);
    const body = await gone.json();
    expect(body.error).toMatchObject({ code: 'not-found' });
    expect(body.attempts.length).toBeGreaterThan(0);

    expect((await app.request(`/api/v1/transcript?url=${ZOO}&format=pdf`)).status).toBe(400);
    expect((await app.request(`/api/v1/context?url=${ZOO}&mode=telepathy`)).status).toBe(400);

    const unsupported = await app.request('/api/v1/metadata?url=not%20a%20video');
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error.code).toBe('unsupported-input');

    const noRoute = await app.request('/api/v1/nope');
    expect(noRoute.status).toBe(404);
    expect((await noRoute.json()).error).toMatchObject({ code: 'not-found', hint: expect.stringContaining('openapi.json') });
  });

  it('marks every /api response noindex and echoes or creates a request id', async () => {
    const { app } = makeApp();
    const given = await app.request('/api/v1/health', { headers: { 'x-request-id': 'req-123' } });
    expect(given.headers.get('x-request-id')).toBe('req-123');
    expect(given.headers.get('x-robots-tag')).toBe('noindex');
    const made = await app.request('/api/v1/nope', { headers: { 'x-request-id': 'bad id with spaces' } });
    expect(made.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(made.headers.get('x-robots-tag')).toBe('noindex');
  });
});

describe('video routes', () => {
  it('serves the context as JSON and the transcript in a chosen format', async () => {
    const { app } = makeApp();
    const ctxRes = await app.request(`/api/v1/context?url=${ZOO}`);
    expect(ctxRes.status).toBe(200);
    expect(ctxRes.headers.get('content-type')).toContain('application/json');
    expect(((await ctxRes.json()) as VideoContext).metadata.title).toBe('Me at the zoo');
    const t = await app.request('/api/v1/transcript?url=jNQXAC9IVRw&timestamps=1');
    expect(t.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect((await t.text()).split('\n')[0]).toBe('[0:01] All right, so here we are, in front of the elephants');
    const srt = await app.request('/api/v1/transcript?url=jNQXAC9IVRw&format=srt');
    expect(srt.headers.get('content-type')).toBe('application/x-subrip; charset=utf-8');
    expect(await srt.text()).toMatch(/^1\r?\n00:00:01,/);
  });

  it('translates with translate=1 through the platform track first, keeping the stored transcript in its language', async () => {
    const { app, fetch } = makeApp();
    const res = await app.request('/api/v1/transcript?url=jNQXAC9IVRw&lang=de&translate=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-translated-via')).toBe('platform');
    expect((await res.text()).trim().startsWith('Also hier sind wir vor den Elefanten.')).toBe(true);
    expect(fetch.calls.some((c) => /timedtext.*lang=de/.test(c.url))).toBe(true);
    const saved = (await (await app.request('/api/v1/library/youtube%3AjNQXAC9IVRw')).json()) as VideoContext;
    expect(saved.transcript.language).toBe('en');

    const noLang = await app.request('/api/v1/transcript?url=jNQXAC9IVRw&translate=1');
    expect(noLang.status).toBe(400);
    expect((await noLang.json()).error.hint).toContain('lang=');
  });

  it('removes SponsorBlock segments with skip= and credits SponsorBlock, keeping the stored transcript whole', async () => {
    const { storage } = await seededStorage();
    const { app } = makeApp({ storage });
    const whole = await (await app.request('/api/v1/transcript?url=CrO0Timw2z4')).text();
    const res = await app.request('/api/v1/transcript?url=CrO0Timw2z4&skip=sponsor');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-data-attribution')).toContain('SponsorBlock');
    const skipped = await res.text();
    expect(skipped.length).toBeLessThan(whole.length);
    expect((await storage.getContext('youtube:CrO0Timw2z4'))?.transcript.segments.length).toBe(601);
  });

  it('serves metadata without fetching captions', async () => {
    const { app, fetch } = makeApp();
    const res = await app.request(`/api/v1/metadata?url=${ZOO}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: 'Me at the zoo', ref: { id: 'youtube:jNQXAC9IVRw' } });
    expect(calls(fetch, /timedtext/)).toBe(0);
  });

  it('expands a single video to itself in /items', async () => {
    const { app } = makeApp();
    const body = await (await app.request(`/api/v1/items?url=${ZOO}&limit=5`)).json();
    expect(body.items).toEqual([expect.objectContaining({ id: 'youtube:jNQXAC9IVRw', kind: 'video' })]);
    expect((await app.request(`/api/v1/items?url=${ZOO}&limit=0`)).status).toBe(400);
  });

  it('names the playlist a video link sits in, and expands it only on playlist=1', async () => {
    const { app, fetch } = makeApp();
    const watch = encodeURIComponent('https://www.youtube.com/watch?v=PzJL3aBRas8&list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b');
    const body = await (await app.request(`/api/v1/items?url=${watch}&limit=1`)).json();
    expect(body.items).toEqual([expect.objectContaining({ id: 'youtube:PzJL3aBRas8', kind: 'video' })]);
    expect(body.list).toMatchObject({
      id: 'youtube:playlist:PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
      kind: 'playlist',
      url: 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
    });
    expect(calls(fetch, /./)).toBe(0);
    expect((await (await app.request(`/api/v1/items?url=${ZOO}`)).json()).list).toBeUndefined();
  });

  it('renders sections by time range and by chapter index', async () => {
    const { app } = makeApp();
    const range = await app.request('/api/v1/section?url=jNQXAC9IVRw&from=0:00&to=5&timestamps=1');
    expect(range.status).toBe(200);
    expect(await range.text()).toBe('[0:01] All right, so here we are, in front of the elephants\n');
    const chapter = await app.request('/api/v1/section?url=jNQXAC9IVRw&chapter=0&format=json');
    expect(chapter.headers.get('content-type')).toBe('application/json');
    const section = (await chapter.json()) as VideoContext;
    expect(section.metadata.extra?.section).toMatchObject({ fromSec: 0 });
    expect((await app.request('/api/v1/section?url=jNQXAC9IVRw')).status).toBe(400);
    expect((await app.request('/api/v1/section?url=jNQXAC9IVRw&from=soon')).status).toBe(400);
  });

  it('returns an outline with token estimates', async () => {
    const { app } = makeApp();
    const body = await (await app.request('/api/v1/outline?url=jNQXAC9IVRw')).json();
    expect(body.metadata.title).toBe('Me at the zoo');
    expect(body.chapters.length).toBeGreaterThan(0);
    expect(body.totalTokens).toBe(body.chapters.reduce((n: number, c: { tokens: number }) => n + c.tokens, 0));
  });

  it('returns comments from the source provider', async () => {
    const { app } = makeApp({ env: { YOUTUBE_COMMENT_REPLIES: '0' } });
    const res = await app.request('/api/v1/comments?url=Pqdv2ql971M&limit=5');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(5);
    expect(body.comments[0]).toMatchObject({ id: expect.any(String), author: expect.any(String), text: expect.any(String) });
    expect((await app.request('/api/v1/comments?url=Pqdv2ql971M&limit=5000')).status).toBe(400);
  });

  it('builds a context pack for one video and for a collection', async () => {
    const { storage, collectionId } = await seededStorage();
    const { app, fetch } = makeApp({ storage });
    const one = await app.request('/api/v1/pack?url=jNQXAC9IVRw&maxTokens=2000');
    expect(one.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await one.text()).toContain('Me at the zoo');

    const many = await app.request('/api/v1/pack', { method: 'POST', body: JSON.stringify({ collectionId }) });
    expect(many.status).toBe(200);
    const text = await many.text();
    expect(text).toContain('Me at the zoo');
    expect(text).toContain(sharedContext('youtube-cCPsdFdlshc.json').metadata.title);
    expect(fetch.calls).toHaveLength(0);

    const bad = await app.request('/api/v1/pack', { method: 'POST', body: '{"inputs": "jNQXAC9IVRw"}' });
    expect(bad.status).toBe(400);
    const empty = await app.request('/api/v1/pack', { method: 'POST', body: '{}' });
    expect((await empty.json()).error.code).toBe('bad-request');
    const unknown = await app.request('/api/v1/pack', { method: 'POST', body: '{"collectionId": "missing"}' });
    expect(unknown.status).toBe(404);
  });

  it('shares one pipeline run between identical concurrent requests', async () => {
    const single = makeApp();
    await single.app.request(`/api/v1/context?url=${ZOO}`);
    const oneRun = calls(single.fetch, /youtubei\/v1\/player/);
    expect(oneRun).toBeGreaterThan(0);

    const { app, fetch } = makeApp();
    const [a, b] = await Promise.all([app.request(`/api/v1/context?url=${ZOO}`), app.request(`/api/v1/context?url=${ZOO}`)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.text()).toBe(await b.text());
    expect(calls(fetch, /youtubei\/v1\/player/)).toBe(oneRun);
    expect(calls(fetch, /timedtext/)).toBe(calls(single.fetch, /timedtext/));
  });

  it('sends an ETag on /context and answers 304 when it matches', async () => {
    const { app } = makeApp();
    const first = await app.request(`/api/v1/context?url=${ZOO}`);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    const again = await app.request(`/api/v1/context?url=${ZOO}`, { headers: { 'if-none-match': `W/${etag}` } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });
});

describe('library', () => {
  it('lists, fetches with URL-encoded ids and ETags, and deletes saved contexts', async () => {
    const { app } = makeApp();
    await app.request(`/api/v1/context?url=${ZOO}`);
    const page = await (await app.request('/api/v1/library?limit=10')).json();
    expect(page.items).toEqual([expect.objectContaining({ id: 'youtube:jNQXAC9IVRw', title: 'Me at the zoo' })]);

    const one = await app.request('/api/v1/library/youtube%3AjNQXAC9IVRw');
    expect(one.status).toBe(200);
    expect(((await one.json()) as VideoContext).metadata.ref.id).toBe('youtube:jNQXAC9IVRw');
    const cached = await app.request('/api/v1/library/youtube%3AjNQXAC9IVRw', {
      headers: { 'if-none-match': one.headers.get('etag') ?? '' },
    });
    expect(cached.status).toBe(304);
    expect((await app.request('/api/v1/library/youtube%253AjNQXAC9IVRw')).status).toBe(200);

    const del = await app.request('/api/v1/library/youtube%3AjNQXAC9IVRw', { method: 'DELETE' });
    expect(del.status).toBe(204);
    const after = await app.request('/api/v1/library/youtube%3AjNQXAC9IVRw');
    expect(after.status).toBe(404);
    expect((await after.json()).error.hint).toContain('/api/v1/library');
    expect((await app.request('/api/v1/library/youtube%3AjNQXAC9IVRw', { method: 'DELETE' })).status).toBe(404);
    expect((await app.request('/api/v1/library?limit=999')).status).toBe(400);
  });
});

describe('models', () => {
  it('lists rungs as ModelInfo with env var names only, and the default policy', async () => {
    const { app } = makeApp({ env: { GROQ_API_KEY: 'gsk_secret_value', VID2CONTEXT_POLICY: 'quality' } });
    const body = await (await app.request('/api/v1/models?kind=stt')).json();
    expect(body.defaultPolicy).toBe('quality');
    expect(body.models.every((m: { kind: string }) => m.kind === 'stt')).toBe(true);
    const groq = body.models.find((m: { id: string }) => m.id === 'stt/groq/whisper-large-v3-turbo');
    expect(groq).toMatchObject({
      label: 'whisper-large-v3-turbo',
      service: 'groq',
      tier: 'free',
      enabled: true,
      requires: ['GROQ_API_KEY'],
    });
    const ovhRung = body.models.find((m: { service: string }) => m.service === 'ovh');
    expect(ovhRung).toMatchObject({ tier: 'keyless', enabled: true, requires: [] });
    expect(JSON.stringify(body)).not.toContain('gsk_secret_value');

    const keyless = makeApp({ env: { VID2CONTEXT_KEYLESS: '0' } });
    const off = await (await keyless.app.request('/api/v1/models')).json();
    expect(off.defaultPolicy).toBe('free');
    expect(off.models.find((m: { service: string }) => m.service === 'ovh').enabled).toBe(false);
    expect((await app.request('/api/v1/models?kind=tts')).status).toBe(400);
  });
});

describe('openapi.json', () => {
  it('describes every served route as OpenAPI 3.1 with resolvable references', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe('3.1.0');

    // CORS preflight (OPTIONS) handlers and middleware (ALL) are not operations.
    const served = new Set(
      app.routes
        .filter((r) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && !r.path.includes('*'))
        .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`),
    );
    const listed = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, { responses: object }>>)) {
      for (const [method, op] of Object.entries(item)) {
        listed.add(`${method} ${path}`);
        expect(Object.keys(op.responses).length).toBeGreaterThan(0);
      }
    }
    expect([...served].filter((r) => !listed.has(r))).toEqual([]);
    expect([...listed].filter((r) => !served.has(r))).toEqual([]);
    for (const route of [
      'get /api/v1/library/{id}',
      'post /api/v1/uploads',
      'get /api/v1/bundle',
      'get /api/v1/models',
      'post /api/v1/chat',
      'get /api/v1/search',
      'post /api/v1/chapters',
      'post /api/v1/briefs',
      'post /api/v1/extract',
      'post /mcp',
    ]) {
      expect(listed).toContain(route);
    }

    const text = JSON.stringify(doc);
    for (const m of text.matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z]+)"/g)) {
      expect(doc.components.schemas).toHaveProperty(m[1] as string);
    }
    const ids = Object.values(doc.paths as Record<string, Record<string, { operationId?: string }>>)
      .flatMap((item) => Object.values(item).map((op) => op.operationId))
      .filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.paths['/api/v1/health'].get.security).toEqual([]);
  });
});
