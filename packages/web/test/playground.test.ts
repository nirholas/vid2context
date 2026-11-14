import { describe, expect, it } from 'vitest';
import { CATALOG, type Endpoint, findEndpoint, videoIdOf } from '../src/lib/api-catalog.ts';
import {
  buildRequest,
  createdId,
  isBrowserFlow,
  isMissing,
  mergeOpenApi,
  rootOf,
  routeKey,
  serverPath,
  shellQuote,
  toCurl,
  varsFor,
} from '../src/lib/playground.ts';
import { displayText, errorOf, formatBytes, send } from '../src/lib/playground-send.ts';
import { parseRoute } from '../src/lib/route.ts';
import { BASE, recorded, replay } from './helpers.ts';

const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const MISSING = 'https://www.youtube.com/watch?v=xxxxxxxxxxx';
const ep = (id: string): Endpoint => {
  const e = findEndpoint(CATALOG, id);
  if (!e) throw new Error(`no endpoint ${id}`);
  return e;
};

describe('API catalog', () => {
  it('has unique ids and unique method and path pairs', () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
    expect(new Set(CATALOG.map((e) => routeKey(e.method, e.path))).size).toBe(CATALOG.length);
  });

  it('lists only routes a full Node server really serves', () => {
    const { served } = mergeOpenApi(CATALOG, recorded('openapi.json').body);
    const absent = CATALOG.filter((e) => isMissing(e, served)).map((e) => e.id);
    expect(absent).toEqual([]);
  });

  it('never marks a test-all route as changing data', () => {
    for (const e of CATALOG.filter((x) => x.smoke)) {
      expect(e.method).toBe('GET');
      expect(e.mutates).toBeFalsy();
    }
  });

  it('turns YouTube links into library ids', () => {
    expect(videoIdOf(VIDEO)).toBe('youtube:jNQXAC9IVRw');
    expect(videoIdOf('https://youtu.be/jNQXAC9IVRw?t=3')).toBe('youtube:jNQXAC9IVRw');
    expect(videoIdOf('https://www.youtube.com/shorts/jNQXAC9IVRw')).toBe('youtube:jNQXAC9IVRw');
    expect(videoIdOf('jNQXAC9IVRw')).toBe('youtube:jNQXAC9IVRw');
    expect(videoIdOf('upload:abc')).toBe('upload:abc');
  });
});

describe('request building', () => {
  it('fills parameters from the video and drops empty ones', () => {
    const r = buildRequest(ep('transcript'), undefined, varsFor(VIDEO), BASE);
    expect(r.url).toBe(`${BASE}/transcript?url=${encodeURIComponent(VIDEO)}&format=text`);
    expect(r.missing).toEqual([]);
    expect(r.body).toBeUndefined();
  });

  it('applies overrides, booleans and path parameters', () => {
    const vars = varsFor(VIDEO);
    const t = buildRequest(ep('transcript'), { values: { format: 'srt', timestamps: '1' } }, vars, BASE);
    expect(new URL(t.url).searchParams.get('format')).toBe('srt');
    expect(new URL(t.url).searchParams.get('timestamps')).toBe('1');
    const lib = buildRequest(ep('library-get'), undefined, vars, BASE);
    expect(lib.url).toBe(`${BASE}/library/youtube%3AjNQXAC9IVRw`);
  });

  it('reports missing required fields and bad JSON', () => {
    const vars = varsFor(VIDEO);
    expect(buildRequest(ep('collections-get'), undefined, vars, BASE).missing).toEqual(['id']);
    expect(buildRequest(ep('collections-get'), undefined, { ...vars, lastId: 'c1' }, BASE).url).toBe(`${BASE}/collections/c1`);
    expect(buildRequest(ep('uploads'), undefined, vars, BASE).missing).toEqual(['file']);
    const bad = buildRequest(ep('ask'), { values: {}, body: '{ nope' }, vars, BASE);
    expect(bad.bodyError).toBeTruthy();
  });

  it('builds example bodies from the recommended video', () => {
    const r = buildRequest(ep('research'), undefined, varsFor(VIDEO), BASE);
    expect(JSON.parse(r.body as string)).toEqual({ urls: [VIDEO], query: 'elephants', contextSec: 20, maxExcerpts: 5 });
    expect(r.headers['content-type']).toBe('application/json');
  });

  it('sends the key as a bearer token but keeps it out of curl', () => {
    const r = buildRequest(ep('ask'), undefined, varsFor(VIDEO), BASE, { apiKey: 'secret-value' });
    expect(r.headers.authorization).toBe('Bearer secret-value');
    const curl = toCurl(r, 'http://localhost');
    expect(curl).not.toContain('secret-value');
    expect(curl).toContain('"Authorization: Bearer $VID2CONTEXT_API_KEY"');
    expect(curl).toContain(`-X POST '${BASE}/ask'`);
    expect(curl).toContain(`-d '{"question":"What does he say about the elephants?","inputs":["${VIDEO}"]}'`);
  });

  it('makes relative bases absolute in curl and quotes for the shell', () => {
    const r = buildRequest(ep('health'), undefined, varsFor(VIDEO), '/api/v1');
    expect(toCurl(r, 'https://vid2context.com')).toBe("curl -sS 'https://vid2context.com/api/v1/health'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const chat = toCurl(buildRequest(ep('chat'), undefined, varsFor(VIDEO), BASE), 'http://x');
    expect(chat.startsWith('curl -N -sS')).toBe(true);
  });

  it('resolves root routes against the server root', () => {
    expect(rootOf('https://vid2context.com/api/v1')).toBe('https://vid2context.com');
    expect(rootOf('/api/v1')).toBe('');
  });

  it('picks up ids that create routes and jobs return', () => {
    expect(createdId(ep('collections-create'), { id: 'c1', name: 'x' })).toEqual({ group: 'Collections', id: 'c1' });
    expect(createdId(ep('briefs'), { id: 'j1', kind: 'brief', status: 'queued' })).toEqual({ group: 'Jobs', id: 'j1' });
    expect(createdId(ep('collections-import'), { collection: { id: 'c2' } })).toEqual({ group: 'Collections', id: 'c2' });
    expect(createdId(ep('collections-get'), { id: 'c1' })).toBeUndefined();
  });
});

describe('OpenAPI merge', () => {
  const doc = recorded('openapi.json').body;
  const merged = mergeOpenApi(CATALOG, doc);

  it('adds routes the catalog lacks under Other and leaves out browser sign-in flows', () => {
    const other = merged.endpoints.filter((e) => e.group === 'Other');
    expect(other.length).toBeGreaterThan(0);
    expect(other.some((e) => e.root && e.path === '/mcp' && e.method === 'POST')).toBe(true);
    expect(other.some((e) => isBrowserFlow(serverPath(e)))).toBe(false);
    expect(new Set(merged.endpoints.map((e) => e.id)).size).toBe(merged.endpoints.length);
  });

  it('keeps the catalog alone when the document cannot be read', () => {
    expect(mergeOpenApi(CATALOG, null)).toEqual({ endpoints: CATALOG });
    expect(isMissing(ep('health'), undefined)).toBe(false);
  });

  it('marks a route the server does not list', () => {
    const served = new Set(['GET /api/v1/health']);
    expect(isMissing(ep('health'), served)).toBe(false);
    expect(isMissing(ep('me'), served)).toBe(true);
  });
});

describe('sending', () => {
  it('reads a JSON answer from a real server', async () => {
    const r = buildRequest(ep('health'), undefined, varsFor(VIDEO), BASE);
    const a = await send(r, { fetch: replay('health.json') });
    expect(a.status).toBe(200);
    expect(a.ok).toBe(true);
    expect((a.json as { name: string }).name).toBe('vid2context');
    expect(a.bytes).toBeGreaterThan(0);
    expect(displayText(a)).toContain('"name": "vid2context"');
  });

  it('surfaces the standard error body', async () => {
    const r = buildRequest(ep('context'), undefined, varsFor(MISSING), BASE);
    const a = await send(r, { fetch: replay('context-not-found.json') });
    expect(a.status).toBe(404);
    expect(errorOf(a)?.code).toBe('not-found');
    expect(errorOf(a)?.hint).toBeTruthy();
  });

  it('streams server-sent events as text', async () => {
    const job = recorded('job-context-events.json');
    const r = {
      ...buildRequest(ep('jobs-events'), undefined, { ...varsFor(VIDEO), lastId: 'x' }, BASE),
      url: `${BASE}${job.request.path}`,
    };
    const seen: number[] = [];
    const a = await send(r, {
      fetch: replay('job-context-events.json'),
      throttleMs: 0,
      onProgress: (p) => seen.push(p.text?.length ?? 0),
    });
    expect(a.text).toContain('event: done');
    expect(seen.length).toBeGreaterThan(0);
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});

describe('route', () => {
  it('parses the API view', () => {
    expect(parseRoute('?view=api')).toEqual({ view: 'api', endpoint: undefined, video: undefined });
    expect(parseRoute(`?view=api&endpoint=transcript&video=${encodeURIComponent(VIDEO)}`)).toEqual({
      view: 'api',
      endpoint: 'transcript',
      video: VIDEO,
    });
  });
});
