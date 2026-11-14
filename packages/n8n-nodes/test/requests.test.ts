import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiBase,
  apiErrorMessage,
  contextRequest,
  type FullResponse,
  healthRequest,
  isMissingRoute,
  itemsRequest,
  metadataRequest,
  transcriptItem,
  transcriptRequest,
} from '../src/shared/requests.ts';
import { type ApiServer, fetchRequester, startApi } from './harness.ts';

describe('request building', () => {
  it('normalizes the base URL the user typed', () => {
    expect(apiBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(apiBase(' https://v2c.example.com/ ')).toBe('https://v2c.example.com');
    expect(apiBase('https://v2c.example.com/api/v1/')).toBe('https://v2c.example.com');
    expect(() => apiBase('v2c.example.com')).toThrow(/http:\/\/ or https:\/\//);
  });

  it('builds the transcript request with only the options that are set', () => {
    expect(transcriptRequest('http://h', { url: ' https://youtu.be/jNQXAC9IVRw ', format: 'text', timestamps: true })).toEqual({
      method: 'GET',
      baseURL: 'http://h',
      url: '/api/v1/transcript',
      qs: { url: 'https://youtu.be/jNQXAC9IVRw', format: 'text', timestamps: '1' },
      encoding: 'text',
      json: false,
      returnFullResponse: true,
    });
    expect(transcriptRequest('http://h', { url: 'jNQXAC9IVRw', mode: 'captions', lang: 'de', timestamps: false }).qs).toEqual({
      url: 'jNQXAC9IVRw',
      format: 'text',
      mode: 'captions',
      lang: 'de',
    });
    expect(() => transcriptRequest('http://h', { url: '  ' })).toThrow(/Video URL is empty/);
  });

  it('builds the context request', () => {
    expect(contextRequest('http://h', { url: 'jNQXAC9IVRw', mode: 'auto' })).toEqual({
      method: 'GET',
      baseURL: 'http://h',
      url: '/api/v1/context',
      qs: { url: 'jNQXAC9IVRw', mode: 'auto' },
      json: true,
    });
  });
});

describe('metadata and items requests', () => {
  it('asks /metadata for status errors as values, so a missing route can fall back to /context', () => {
    expect(metadataRequest('http://h', { url: 'jNQXAC9IVRw', mode: 'stt' })).toEqual({
      method: 'GET',
      baseURL: 'http://h',
      url: '/api/v1/metadata',
      qs: { url: 'jNQXAC9IVRw' },
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
  });

  it('builds the items request with an optional whole-number limit', () => {
    expect(itemsRequest('http://h', { url: 'https://www.youtube.com/playlist?list=PL1', limit: 25.7 })).toEqual({
      method: 'GET',
      baseURL: 'http://h',
      url: '/api/v1/items',
      qs: { url: 'https://www.youtube.com/playlist?list=PL1', limit: '25' },
      json: true,
    });
    expect(itemsRequest('http://h', { url: 'x', limit: 0 }).qs).toEqual({ url: 'x' });
  });
});

describe('requests against a real vid2context server (recorded YouTube responses underneath)', () => {
  let api: ApiServer;
  const request = fetchRequester();
  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });

  it('Get Transcript returns text with timestamps', async () => {
    const params = { url: 'https://youtu.be/jNQXAC9IVRw', format: 'text', timestamps: true };
    const item = transcriptItem(params, (await request(transcriptRequest(api.base, params))) as FullResponse);
    expect(item.contentType).toBe('text/plain; charset=utf-8');
    expect(String(item.transcript).split('\n')[0]).toBe('[0:01] All right, so here we are, in front of the elephants');
  });

  it('Get Transcript in the json format returns parsed JSON', async () => {
    const params = { url: 'jNQXAC9IVRw', format: 'json' };
    const item = transcriptItem(params, (await request(transcriptRequest(api.base, params))) as FullResponse);
    expect(item.contentType).toContain('application/json');
    const transcript = item.transcript as { metadata: { title: string } };
    expect(transcript.metadata.title).toBe('Me at the zoo');
  });

  it('Get Context and Get Metadata read the VideoContext', async () => {
    const context = (await request(contextRequest(api.base, { url: 'jNQXAC9IVRw' }))) as {
      metadata: { title: string; chapters: unknown[] };
      transcript: { segments: unknown[] };
    };
    expect(context.metadata.title).toBe('Me at the zoo');
    expect(context.metadata.chapters).toHaveLength(3);
    expect(context.transcript.segments.length).toBe(6);
  });

  it('Get Metadata reads /metadata, or /context on a server without that route', async () => {
    const res = (await request(metadataRequest(api.base, { url: 'jNQXAC9IVRw' }))) as FullResponse;
    const metadata = isMissingRoute(res)
      ? ((await request(contextRequest(api.base, { url: 'jNQXAC9IVRw' }))) as { metadata: { title: string } }).metadata
      : (res.body as { title: string });
    expect(metadata.title).toBe('Me at the zoo');
  });

  it('tells a missing route apart from a missing video', async () => {
    const route = (await request({
      method: 'GET',
      baseURL: api.base,
      url: '/api/v1/no-such-route',
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    })) as FullResponse;
    expect(isMissingRoute(route)).toBe(true);
    const video = (await request({
      ...contextRequest(api.base, { url: 'xxxxxxxxxxx' }),
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    })) as FullResponse;
    expect(video.statusCode).toBe(404);
    expect(isMissingRoute(video)).toBe(false);
    expect(apiErrorMessage(video)).toMatch(/^not-found: /);
  });

  it('the format list comes from the server health route', async () => {
    const health = (await request(healthRequest(api.base))) as { formats: { id: string }[] };
    expect(health.formats.map((f) => f.id)).toEqual(expect.arrayContaining(['text', 'json']));
  });

  it('API errors surface with their status', async () => {
    await expect(request(contextRequest(api.base, { url: 'xxxxxxxxxxx' }))).rejects.toMatchObject({
      httpCode: '404',
      body: { error: { code: 'not-found' } },
    });
  });
});
