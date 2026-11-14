/**
 * askRoutes mounted on a bare Hono app, answering from recorded LLM
 * responses. The SSE body is parsed with eventsource-parser, a real SSE
 * parser, and checked against the /chat contract field for field.
 */
import { clearCooldowns, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { askRoutes } from '../src/http.ts';
import { GWAGON_URL, loadRecording, makeRegistry, makeStorage, replayRecording } from './helpers.ts';

beforeEach(() => clearCooldowns());

async function appFor(recording: string, env: Record<string, string> = {}) {
  const fetch = replayRecording(loadRecording(recording));
  const { storage } = await makeStorage();
  const app = new Hono();
  app.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    return c.json(
      { error: { code: e?.code ?? 'internal', message: err.message, ...(e?.hint ? { hint: e.hint } : {}) }, attempts: [] },
      e ? 400 : 500,
    );
  });
  app.route(
    '/api/v1',
    askRoutes({
      registry: makeRegistry(),
      makeCtx: (req) => testContext({ fetch, env, signal: req.signal }),
      storage: async () => storage,
    }),
  );
  return { app, fetch };
}

function parseSse(text: string): EventSourceMessage[] {
  const events: EventSourceMessage[] = [];
  const parser = createParser({ onEvent: (e) => events.push(e) });
  parser.feed(text);
  return events;
}

const keys = (o: unknown) => Object.keys(o as object).sort();

describe('POST /chat', () => {
  it('streams meta, delta+, done matching the SSE contract', async () => {
    const { app } = await appFor('chat-sse-designo');
    const res = await app.request('/api/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Which years have the designo seats?' }],
        context: { inputs: [GWAGON_URL] },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    const names = events.map((e) => e.event);
    expect(names[0]).toBe('meta');
    expect(names.at(-1)).toBe('done');
    expect(names.slice(1, -1).every((n) => n === 'delta' || n === 'reasoning')).toBe(true);
    expect(names).toContain('delta');

    const meta = JSON.parse(events[0]?.data ?? '{}');
    expect(keys(meta)).toEqual(['contextTokens', 'model', 'promptTokens', 'rung', 'sources']);
    for (const s of meta.sources) {
      expect(keys(s)).toEqual(['endSec', 'n', 'startSec', 'title', 'url', 'videoId']);
      expect(typeof s.n).toBe('number');
    }
    const deltas = events.filter((e) => e.event === 'delta').map((e) => JSON.parse(e.data).text as string);
    const done = JSON.parse(events.at(-1)?.data ?? '{}');
    expect(keys(done)).toEqual(expect.arrayContaining(['attempts', 'citations', 'model', 'rung', 'text', 'unverified']));
    expect(done.text).toBe(deltas.join('').trim());
    expect(done.rung).toBe(meta.rung);
    expect(done.text).toMatch(/2018/);
    expect(done.citations.length).toBeGreaterThan(0);
    for (const c of done.citations) {
      expect(keys(c)).toEqual(['endSec', 'n', 'quote', 'startSec', 'title', 'url', 'videoId']);
      expect(meta.sources.some((s: { n: number }) => s.n === c.n)).toBe(true);
    }
  });

  it('sends an error event when every rung fails', async () => {
    const { app } = await appFor('all-429', { VID2CONTEXT_SKIP: 'pollinations' });
    const res = await app.request('/api/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Which years have timing chains?' }],
        context: { inputs: [GWAGON_URL] },
      }),
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['error']);
    const err = JSON.parse(events[0]?.data ?? '{}');
    expect(err.code).toBe('all-rungs-failed');
    expect(err.hint).toBeTruthy();
    expect(err.attempts.map((a: { reason: string }) => a.reason)).toEqual(['rate-limited-429', 'rate-limited-429']);
  });

  it('answers a bad body with the standard error body before streaming', async () => {
    const { app } = await appFor('chat-sse-designo');
    const res = await app.request('/api/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'assistant', content: 'hi' }] }),
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.error.code).toBe('bad-request');
    expect(body.error.hint).toBeTruthy();
  });
});

describe('POST /ask', () => {
  it('returns JSON with answer, citations, rung and attempts', async () => {
    const { app } = await appFor('gwagon-g55');
    const res = await app.request('/api/v1/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'How much horsepower does the G55 AMG compressor engine make, and does it have any known issues?',
        inputs: [GWAGON_URL],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.answer).toBe('string');
    expect(Array.isArray(body.citations)).toBe(true);
    expect(body.rung).toMatch(/^llm\//);
    expect(Array.isArray(body.attempts)).toBe(true);
  });

  it('streams the same events when stream is true', async () => {
    const { app } = await appFor('gwagon-g55');
    const res = await app.request('/api/v1/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'How much horsepower does the G55 AMG compressor engine make, and does it have any known issues?',
        inputs: [GWAGON_URL],
        stream: true,
      }),
    });
    const names = parseSse(await res.text()).map((e) => e.event);
    expect(names[0]).toBe('meta');
    expect(names.at(-1)).toBe('done');
  });
});
