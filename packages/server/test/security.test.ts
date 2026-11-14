import { createHash } from 'node:crypto';
import { MemoryKv } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { digestEqual, parseApiKeys, requiredScope } from '../src/auth.ts';
import { takeToken } from '../src/rate-limit.ts';
import { makeApp, yt } from './helpers.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

const READER = 'reader-key-6f1d2c';
const WRITER = 'writer-key-93ab47';
const PLAIN = 'plain-key-55e0aa';
const KEYS = [PLAIN, `ci-reader:read:${sha(READER)}`, `ingest:write:${sha(WRITER)}`].join(', ');

describe('API keys', () => {
  it('is open when no keys are set', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/v1/formats')).status).toBe(200);
  });

  it('parses plain and hashed entries, naming plain keys by position', async () => {
    const entries = await parseApiKeys(KEYS);
    expect(entries.map((e) => [e.name, e.scope])).toEqual([
      ['key-1', 'admin'],
      ['ci-reader', 'read'],
      ['ingest', 'write'],
    ]);
    expect(Buffer.from(entries[1]?.hash ?? []).toString('hex')).toBe(sha(READER));
    const a = new Uint8Array(32).fill(7);
    expect(digestEqual(a, new Uint8Array(32).fill(7))).toBe(true);
    expect(digestEqual(a, new Uint8Array(32).fill(8))).toBe(false);
  });

  it('requires a valid key on every route except /health', async () => {
    const { app, logs } = makeApp({ env: { VID2CONTEXT_API_KEYS: KEYS } });
    expect((await app.request('/api/v1/health')).status).toBe(200);

    const missing = await app.request('/api/v1/formats');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');
    expect(await missing.json()).toMatchObject({ error: { code: 'unauthorized', hint: expect.any(String) }, attempts: [] });

    const wrong = await app.request('/api/v1/formats', { headers: bearer('not-a-key') });
    expect(wrong.status).toBe(401);
    expect((await app.request('/api/v1/openapi.json')).status).toBe(401);

    const plain = await app.request('/api/v1/formats', { headers: bearer(PLAIN) });
    expect(plain.status).toBe(200);
    const reader = await app.request('/api/v1/formats', { headers: bearer(READER) });
    expect(reader.status).toBe(200);

    // Logs name the key, never contain it.
    const named = logs.filter((l) => l.path === '/api/v1/formats' && l.status === 200).map((l) => l.key);
    expect(named).toEqual(['key-1', 'ci-reader']);
    const allLogs = JSON.stringify(logs);
    for (const k of [PLAIN, READER, WRITER]) expect(allLogs).not.toContain(k);
  });

  it('enforces scopes: read for GET and read-only POSTs, write for changes and deletes', async () => {
    expect(requiredScope('GET', '/api/v1/library')).toBe('read');
    expect(requiredScope('POST', '/api/v1/pack')).toBe('read');
    expect(requiredScope('POST', '/api/v1/uploads')).toBe('write');
    expect(requiredScope('DELETE', '/api/v1/library/x')).toBe('write');
    expect(requiredScope('PATCH', '/api/v1/collections/x')).toBe('write');

    const { app } = makeApp({ env: { VID2CONTEXT_API_KEYS: KEYS } });
    const denied = await app.request('/api/v1/library/youtube%3AjNQXAC9IVRw', { method: 'DELETE', headers: bearer(READER) });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatchObject({ code: 'forbidden', hint: expect.stringContaining('write') });

    const allowed = await app.request('/api/v1/library/youtube%3AjNQXAC9IVRw', { method: 'DELETE', headers: bearer(WRITER) });
    expect(allowed.status).toBe(404); // past auth: the library is empty

    const readPost = await app.request('/api/v1/pack', { method: 'POST', headers: bearer(READER), body: '{}' });
    expect(readPost.status).toBe(400); // past auth: the body names no videos
  });
});

describe('rate limits', () => {
  it('refills a token bucket at the per-minute rate', async () => {
    const kv = new MemoryKv();
    const opts = { perMinute: 60, burst: 2 };
    expect(await takeToken(kv, 'ip:a', { ...opts, now: 0 })).toMatchObject({ ok: true, remaining: 1 });
    expect(await takeToken(kv, 'ip:a', { ...opts, now: 0 })).toMatchObject({ ok: true, remaining: 0 });
    expect(await takeToken(kv, 'ip:a', { ...opts, now: 0 })).toEqual({ ok: false, retryAfterSec: 1, limit: 2 });
    expect(await takeToken(kv, 'ip:a', { ...opts, now: 1000 })).toMatchObject({ ok: true });
    expect(await takeToken(kv, 'ip:b', { ...opts, now: 0 })).toMatchObject({ ok: true });
    expect((await kv.kvList('ratelimit:')).keys).toEqual(['ratelimit:ip:a', 'ratelimit:ip:b']);
  });

  it('answers 429 with Retry-After per key, and keeps /health open', async () => {
    const { app } = makeApp({ env: { VID2CONTEXT_API_KEYS: KEYS, VID2CONTEXT_RATE_LIMIT: '1', VID2CONTEXT_RATE_BURST: '2' } });
    const first = await app.request('/api/v1/formats', { headers: bearer(PLAIN) });
    expect(first.headers.get('x-ratelimit-remaining')).toBe('1');
    expect((await app.request('/api/v1/formats', { headers: bearer(PLAIN) })).status).toBe(200);
    const limited = await app.request('/api/v1/formats', { headers: bearer(PLAIN) });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toMatchObject({ error: { code: 'rate-limited', hint: expect.stringContaining('Retry-After') } });
    // Another key has its own bucket.
    expect((await app.request('/api/v1/formats', { headers: bearer(READER) })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await app.request('/api/v1/health')).status).toBe(200);
  });

  it('limits per client IP in open mode', async () => {
    const { app } = makeApp({
      env: { VID2CONTEXT_RATE_LIMIT: '1', VID2CONTEXT_RATE_BURST: '1', VID2CONTEXT_TRUST_PROXY: '1' },
    });
    const from = (ip: string) => ({ headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });
    expect((await app.request('/api/v1/formats', from('203.0.113.7'))).status).toBe(200);
    expect((await app.request('/api/v1/formats', from('203.0.113.7'))).status).toBe(429);
    expect((await app.request('/api/v1/formats', from('198.51.100.2'))).status).toBe(200);
  });
});

describe('CORS', () => {
  it('sends no CORS headers unless origins are configured', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v1/formats', { headers: { origin: 'https://example.org' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers preflights for allowed origins before auth, and refuses other origins', async () => {
    const { app } = makeApp({
      env: {
        VID2CONTEXT_CORS_ORIGINS: 'https://vid2context.com, chrome-extension://abcdefghijklmnop',
        VID2CONTEXT_API_KEYS: PLAIN,
      },
    });
    const preflight = await app.request('/api/v1/uploads', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://vid2context.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://vid2context.com');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');

    const ext = await app.request('/api/v1/formats', {
      headers: { origin: 'chrome-extension://abcdefghijklmnop', ...bearer(PLAIN) },
    });
    expect(ext.headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdefghijklmnop');
    expect(ext.headers.get('access-control-expose-headers')).toContain('X-Request-Id');

    const other = await app.request('/api/v1/formats', { headers: { origin: 'https://evil.example', ...bearer(PLAIN) } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('limits and public mode', () => {
  it('rejects bodies over VID2CONTEXT_MAX_BODY_KB with too-large', async () => {
    const { app } = makeApp({ env: { VID2CONTEXT_MAX_BODY_KB: '1' } });
    const big = JSON.stringify({ inputs: Array.from({ length: 200 }, () => 'https://youtu.be/jNQXAC9IVRw') });
    const res = await app.request('/api/v1/pack', {
      method: 'POST',
      body: big,
      headers: { 'content-length': String(big.length) },
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('too-large');
  });

  it('answers timeout (504) when a request runs past VID2CONTEXT_REQUEST_TIMEOUT_MS', async () => {
    const { app } = makeApp({
      env: { VID2CONTEXT_REQUEST_TIMEOUT_MS: '50' },
      routes: [
        {
          method: 'POST',
          url: /youtubei\/v1\/player/,
          // The real recording, delivered after the request timeout has passed.
          response: () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ body: yt('player-jNQXAC9IVRw.json'), headers: { 'content-type': 'application/json' } }),
                500,
              ),
            ),
        },
      ],
    });
    const started = Date.now();
    const res = await app.request('/api/v1/context?url=jNQXAC9IVRw');
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatchObject({ code: 'timeout', hint: expect.any(String) });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('refuses local paths and file:// inputs in public mode', async () => {
    const { app } = makeApp({ env: { VID2CONTEXT_PUBLIC: '1' } });
    for (const input of ['/etc/passwd', 'file:///etc/passwd', '../secret.mp3', 'talk.mp3']) {
      const res = await app.request(`/api/v1/context?url=${encodeURIComponent(input)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatchObject({ code: 'unsupported-input', hint: expect.stringContaining('public') });
    }
    const pack = await app.request('/api/v1/pack', { method: 'POST', body: '{"inputs": ["/etc/passwd"]}' });
    expect((await pack.json()).error.code).toBe('unsupported-input');
  });
});
