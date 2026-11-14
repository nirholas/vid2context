import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  attemptsOf,
  clearCooldowns,
  createContext,
  type Env,
  getVideoContext,
  type Logger,
  MemoryKv,
  MemoryStorage,
  Registry,
  type TranscriptMode,
  Vid2ContextError,
} from '@vid2context/core';
import { type ReplayFetch, replayFetch, type Route } from '@vid2context/core/testing';
import mediaFile from '@vid2context/provider-media-file';
import stt from '@vid2context/provider-stt-openai-compatible';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { upsertGithubAccount } from '../src/accounts.ts';
import { sha256Base64url } from '../src/crypto.ts';
import { GITHUB_SCOPE, GITHUB_TOKEN_URL, type OAuthState } from '../src/github.ts';
import { accountOf, accountsRoutes, canTriggerStt, hostedMiddleware } from '../src/http.ts';
import { createSession, SESSION_COOKIE } from '../src/sessions.ts';
import { TURNSTILE_VERIFY_URL } from '../src/turnstile.ts';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const own = (f: string) => read(`packages/accounts/test/fixtures/${f}`);
const APOLLO = fileURLToPath(new URL('tests/fixtures/media/apollo11-small-step.mp3', root));
const SECRET = 'http-test-session-secret-with-more-than-32-chars';
// GitHub's public documentation account (https://api.github.com/users/octocat).
const OCTOCAT = { id: 583231, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' };
const T0 = Date.parse('2026-11-14T22:00:00Z');

// Real recordings: YouTube (providers/youtube/test/fixtures), OVH Whisper (providers/stt-openai-compatible/test/fixtures),
// Cloudflare Turnstile and GitHub (test/fixtures, see README.md there).
const yt = (p: string) => read(`providers/youtube/test/fixtures/${p}`);
const routes: Route[] = [
  {
    method: 'POST',
    url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    response: (call) => {
      const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
      return { body: yt(`player-${videoId === 'jNQXAC9IVRw' ? videoId : 'unavailable'}.json`) };
    },
  },
  { url: /timedtext\?v=jNQXAC9IVRw.*lang=en/, response: { body: yt('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
  {
    method: 'POST',
    url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions',
    response: { body: read('providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json') },
  },
  {
    method: 'POST',
    url: TURNSTILE_VERIFY_URL,
    response: (call) => {
      const secret = new URLSearchParams(String(call.body)).get('secret') ?? '';
      const file = { '1x': 'pass', '2x': 'fail', '3x': 'duplicate' }[secret.slice(0, 2)];
      if (!file) throw new Error(`no recording for Turnstile secret ${secret.slice(0, 2)}`);
      return { body: own(`turnstile-siteverify-${file}.json`), headers: { 'content-type': 'application/json' } };
    },
  },
  {
    method: 'POST',
    url: GITHUB_TOKEN_URL,
    response: { status: 404, body: own('github-token-unknown-client.json'), headers: { 'content-type': 'application/json' } },
  },
];

const registry = new Registry([mediaFile, stt], 'node');
// Loaded only by the tests that resolve YouTube URLs, so the others do not depend on the YouTube provider.
const withYoutube = async () => new Registry([...(await import('@vid2context/provider-youtube')).default, mediaFile, stt], 'node');

interface Harness {
  app: Hono;
  kv: MemoryKv;
  storage: MemoryStorage;
  fetch: ReplayFetch;
  logs: string[];
  clock: { now: number };
  /** A signed-in browser: a GitHub account and a session cookie header. */
  signIn(identity?: typeof OCTOCAT): Promise<{ accountId: string; cookie: string }>;
}

function harness(extraEnv: Env = {}, reg: Registry = registry): Harness {
  const env: Env = {
    VID2CONTEXT_HOSTED: '1',
    VID2CONTEXT_SESSION_SECRET: SECRET,
    GITHUB_OAUTH_CLIENT_ID: 'Ov23li0000000000000000',
    GITHUB_OAUTH_CLIENT_SECRET: '0000000000000000000000000000000000000000',
    ...extraEnv,
  };
  const kv = new MemoryKv();
  const storage = new MemoryStorage();
  const fetch = replayFetch(routes);
  const logs: string[] = [];
  const log: Logger = Object.fromEntries(
    (['debug', 'info', 'warn', 'error'] as const).map((l) => [l, (m: string, d?: object) => logs.push(`${l} ${m} ${JSON.stringify(d ?? {})}`)]),
  ) as unknown as Logger;
  const clock = { now: T0 };
  const deps = {
    makeCtx: (req: Request) => createContext({ runtime: 'node', env, fetch, log, signal: req.signal }),
    kv,
    storage: () => storage,
    clientIp: (c: { req: { header(n: string): string | undefined } }) => c.req.header('x-test-ip') ?? '203.0.113.7',
    now: () => clock.now,
  };

  const app = new Hono();
  // The error body and statuses of docs/contracts/http-api.md, as packages/server applies them.
  app.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    const status = ({ 'bad-request': 400, 'not-found': 404, 'no-transcript': 422, upstream: 502, 'no-provider': 503 } as const)[
      e?.code as 'bad-request'
    ];
    return c.json(
      { error: { code: e?.code ?? 'internal', message: e?.message ?? err.message, ...(e?.hint ? { hint: e.hint } : {}) }, attempts: attemptsOf(err) },
      status ?? 500,
    );
  });
  app.use('*', hostedMiddleware(deps));
  app.route('/api/v1', accountsRoutes(deps));
  app.get('/api/v1/health', (c) => c.json({ ok: true }));
  app.get('/api/v1/metadata', (c) => c.json({ account: accountOf(c)?.id ?? null }));
  app.post('/api/v1/collections/:id/items', (c) => c.json({ accepted: true }, 202));
  // How a pipeline route uses hosted mode: the metered registry and the shared-cache storage.
  app.get('/api/v1/context', async (c) => {
    const mode = (c.req.query('mode') ?? 'auto') as TranscriptMode;
    const hosted = c.get('hosted');
    const result = await getVideoContext(
      hosted ? hosted.registry(reg) : reg,
      c.req.query('url') ?? '',
      { mode, storage: hosted ? hosted.storage(storage, { mode }) : storage },
      deps.makeCtx(c.req.raw),
    );
    return c.json(result);
  });

  return {
    app,
    kv,
    storage,
    fetch,
    logs,
    clock,
    async signIn(identity = OCTOCAT) {
      const account = await upsertGithubAccount(kv, identity, { plan: 'free' });
      const { cookie } = await createSession(kv, SECRET, account.id, { ttlSec: 3600 });
      return { accountId: account.id, cookie: `${SESSION_COOKIE}=${cookie}` };
    },
  };
}

const get = (h: Harness, path: string, headers: Record<string, string> = {}) => h.app.request(path, { headers });

afterEach(() => clearCooldowns());

describe('hosted mode off', () => {
  it('passes every request through and hides the account routes', async () => {
    const h = harness({ VID2CONTEXT_HOSTED: '' });
    expect((await get(h, '/api/v1/metadata')).status).toBe(200);
    const me = await get(h, '/api/v1/me');
    expect(me.status).toBe(404);
    expect((await me.json()).error).toMatchObject({ code: 'not-found', hint: expect.stringContaining('VID2CONTEXT_HOSTED=1') });
  });
});

describe('sign-in with GitHub', () => {
  it('redirects to GitHub with an empty scope, state and an S256 PKCE challenge', async () => {
    const h = harness();
    const res = await get(h, '/api/v1/auth/github/login?return_to=%2Fapp%2F%3Fx%3D1');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location') ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(GITHUB_SCOPE).toBe('');
    expect(url.searchParams.has('scope')).toBe(true);
    expect(url.searchParams.get('scope')).toBe('');
    expect(url.searchParams.get('client_id')).toBe('Ov23li0000000000000000');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/api/v1/auth/github/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await h.kv.kvGet<OAuthState>(`accounts:oauth:${state}`);
    expect(stored).toMatchObject({ returnTo: '/app/?x=1', redirectUri: 'http://localhost/api/v1/auth/github/callback' });
    expect(url.searchParams.get('code_challenge')).toBe(await sha256Base64url(stored?.verifier ?? ''));
    expect(stored?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^__Host-v2c_oauth=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    // No email scope anywhere in the URL.
    expect(url.href).not.toMatch(/email/i);
  });

  it('refuses open redirects in return_to', async () => {
    const h = harness();
    const res = await get(h, '/api/v1/auth/github/login?return_to=%2F%2Fevil.example');
    const state = new URL(res.headers.get('location') ?? '').searchParams.get('state');
    expect((await h.kv.kvGet<OAuthState>(`accounts:oauth:${state}`))?.returnTo).toBe('/app/');
  });

  it('checks state against the browser cookie, uses it once, and handles a cancelled sign-in', async () => {
    const h = harness();
    const start = async () => {
      const res = await get(h, '/api/v1/auth/github/login');
      const state = new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '';
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      return { state, cookie };
    };
    const a = await start();
    const b = await start();
    // No cookie, or the cookie of another sign-in: refused.
    expect((await get(h, `/api/v1/auth/github/callback?state=${a.state}&code=x`)).status).toBe(400);
    expect((await get(h, `/api/v1/auth/github/callback?state=${a.state}&code=x`, { cookie: b.cookie })).status).toBe(400);
    // The user pressed Cancel on GitHub.
    const cancelled = await get(h, `/api/v1/auth/github/callback?state=${a.state}&error=access_denied`, { cookie: a.cookie });
    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.get('location')).toBe('/app/?login=cancelled');
    // The state is spent.
    const replay = await get(h, `/api/v1/auth/github/callback?state=${a.state}&code=x`, { cookie: a.cookie });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.message).toContain('expired or was already used');
  });

  it('sends the PKCE verifier to GitHub and reports an unknown OAuth app (recorded GitHub 404)', async () => {
    const h = harness();
    const login = await get(h, '/api/v1/auth/github/login');
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const verifier = (await h.kv.kvGet<OAuthState>(`accounts:oauth:${state}`))?.verifier;
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await get(h, `/api/v1/auth/github/callback?state=${state}&code=0000000000`, { cookie });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatchObject({ code: 'upstream', hint: expect.stringContaining('GITHUB_OAUTH_CLIENT_ID') });
    const call = h.fetch.calls.find((c) => c.url === GITHUB_TOKEN_URL);
    const body = new URLSearchParams(String(call?.body));
    expect(body.get('code_verifier')).toBe(verifier);
    expect(body.get('redirect_uri')).toBe('http://localhost/api/v1/auth/github/callback');
    expect(call?.headers.accept).toBe('application/json');
  });

  it('answers 503 with a hint when GitHub OAuth is not configured', async () => {
    const h = harness({ GITHUB_OAUTH_CLIENT_ID: '' });
    const res = await get(h, '/api/v1/auth/github/login');
    expect(res.status).toBe(503);
    expect((await res.json()).error.hint).toContain('GITHUB_OAUTH_CLIENT_ID');
  });
});

describe('sessions and API keys over HTTP', () => {
  it('requires a session or key, then serves /me and puts the account on the context', async () => {
    const h = harness();
    const anon = await get(h, '/api/v1/metadata');
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toBe('Bearer realm="vid2context"');
    expect((await anon.json()).error).toMatchObject({ code: 'auth', hint: expect.stringContaining('/api/v1/auth/github/login') });
    expect((await get(h, '/api/v1/health')).status).toBe(200);

    const { accountId, cookie } = await h.signIn();
    expect(await (await get(h, '/api/v1/me', { cookie })).json()).toEqual({
      id: accountId,
      login: 'octocat',
      plan: 'free',
      avatarUrl: OCTOCAT.avatarUrl,
    });
    expect(await (await get(h, '/api/v1/metadata', { cookie })).json()).toEqual({ account: accountId });
    // A tampered cookie is not a session.
    expect((await get(h, '/api/v1/me', { cookie: `${cookie.slice(0, -2)}xx` })).status).toBe(401);
  });

  it('creates a key once, lists it without the secret, accepts it as Bearer and deletes it', async () => {
    const h = harness();
    const { accountId, cookie } = await h.signIn();
    const created = await h.app.request('/api/v1/me/keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ name: 'laptop' }),
    });
    expect(created.status).toBe(201);
    const { key, id, name, prefix } = (await created.json()) as { key: string; id: string; name: string; prefix: string };
    expect(key).toMatch(/^v2c_[A-Za-z0-9_-]{43}$/);
    expect(name).toBe('laptop');

    const listed = await (await get(h, '/api/v1/me/keys', { cookie })).json();
    expect(listed.keys).toEqual([{ id, name: 'laptop', prefix, createdAt: expect.any(String) }]);
    expect(JSON.stringify(listed)).not.toContain(key);

    const bearer = { authorization: `Bearer ${key}` };
    expect(await (await get(h, '/api/v1/metadata', bearer)).json()).toEqual({ account: accountId });
    expect((await get(h, '/api/v1/me/keys', bearer)).status).toBe(200);
    // A key cannot mint or delete keys.
    const viaKey = await h.app.request('/api/v1/me/keys', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{"name":"x"}' });
    expect(viaKey.status).toBe(403);
    // A cross-site form cannot either.
    const cross = await h.app.request('/api/v1/me/keys', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{"name":"x"}',
    });
    expect(cross.status).toBe(403);

    expect((await h.app.request(`/api/v1/me/keys/${id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(204);
    expect((await h.app.request(`/api/v1/me/keys/${id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(404);
    const revoked = await get(h, '/api/v1/metadata', bearer);
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error.message).toContain('not valid');
  });

  it('logs out by deleting the session record', async () => {
    const h = harness();
    const { cookie } = await h.signIn();
    const out = await h.app.request('/api/v1/auth/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^__Host-v2c_session=;.*Max-Age=0/);
    expect((await h.kv.kvList('accounts:session:')).keys).toEqual([]);
    expect((await get(h, '/api/v1/me', { cookie })).status).toBe(401);
  });

  it('logs account ids, never the GitHub login', async () => {
    const h = harness({ VID2CONTEXT_LOG_LEVEL: 'debug' });
    const { accountId, cookie } = await h.signIn();
    await get(h, '/api/v1/metadata', { cookie });
    await h.app.request('/api/v1/me/keys', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"name":"a"}' });
    const all = h.logs.join('\n');
    expect(all).toContain(accountId);
    expect(all).not.toContain('octocat');
    expect(all).not.toContain('203.0.113.7');
  });
});

describe('quotas', () => {
  it('answers 429 with Retry-After and a hint naming the limit, and resets at 00:00 UTC', async () => {
    const h = harness({ VID2CONTEXT_PLANS: '{"free":{"requestsPerDay":2}}' });
    const { cookie } = await h.signIn();
    expect((await get(h, '/api/v1/metadata', { cookie })).status).toBe(200);
    expect((await get(h, '/api/v1/metadata', { cookie })).status).toBe(200);
    const limited = await get(h, '/api/v1/metadata', { cookie });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7200');
    expect(await limited.json()).toEqual({
      error: {
        code: 'rate-limited',
        message: 'This request would exceed the daily request limit (2 requests per day) of the free plan.',
        hint: 'The limit resets at 00:00 UTC, in 2 h 0 min.',
      },
      attempts: [],
    });
    // /me routes are not counted.
    const usage = await (await get(h, '/api/v1/me/usage', { cookie })).json();
    expect(usage).toEqual({
      period: '2026-11-14',
      resetsAt: '2026-11-15T00:00:00.000Z',
      plan: 'free',
      used: { requests: 2, sttMinutes: 0, llmCalls: 0 },
      limits: { requestsPerDay: 2, sttMinutesPerDay: 60, llmCallsPerDay: 100, maxCollectionSize: 200 },
    });
    h.clock.now = Date.parse('2026-11-15T00:00:05Z');
    expect((await get(h, '/api/v1/metadata', { cookie })).status).toBe(200);
  });

  it('counts speech-to-text minutes and turns a refusal mid-request into a 429', async () => {
    const h = harness({ VID2CONTEXT_PLANS: '{"free":{"sttMinutesPerDay":0.3}}' });
    const { cookie } = await h.signIn();
    const url = encodeURIComponent(APOLLO);
    const first = await get(h, `/api/v1/context?url=${url}&mode=stt`, { cookie });
    expect(first.status).toBe(200);
    expect((await (await get(h, '/api/v1/me/usage', { cookie })).json()).used.sttMinutes).toBe(0.4);

    // mode=stt with no minutes left is refused up front.
    const early = await get(h, `/api/v1/context?url=${url}&mode=stt`, { cookie });
    expect(early.status).toBe(429);
    // mode=auto reaches the speech-to-text rung, which refuses; the 422 becomes a 429 naming the limit.
    const late = await get(h, `/api/v1/context?url=${url}`, { cookie });
    expect(late.status).toBe(429);
    expect(late.headers.get('retry-after')).toBe('7200');
    const body = await late.json();
    expect(body.error.message).toContain('daily speech-to-text limit (0.3 audio minutes per day)');
    expect(body.error.hint).toContain('mode=captions');
    expect(h.fetch.calls.filter((c) => c.url.includes('/audio/transcriptions'))).toHaveLength(1);
  });

  it('serves a public video transcribed for one account to the next from the shared cache', async () => {
    const h = harness({}, await withYoutube());
    const a = await h.signIn();
    const b = await h.signIn({ id: 1, login: 'mojombo', avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4' });
    const first = await get(h, '/api/v1/context?url=jNQXAC9IVRw', { cookie: a.cookie });
    expect(first.status).toBe(200);
    const callsAfterA = h.fetch.calls.length;
    const second = await get(h, '/api/v1/context?url=https%3A%2F%2Fyoutu.be%2FjNQXAC9IVRw', { cookie: b.cookie });
    expect(second.status).toBe(200);
    expect((await second.json()).metadata.title).toBe('Me at the zoo');
    expect(h.fetch.calls.length).toBe(callsAfterA);
  });

  it('caps collection size per plan', async () => {
    const h = harness({ VID2CONTEXT_PLANS: '{"free":{"maxCollectionSize":2}}' });
    const { cookie } = await h.signIn();
    const col = await h.storage.createCollection({ name: 'talks' });
    await h.storage.addToCollection(col.id, ['youtube:jNQXAC9IVRw']);
    const post = (inputs: string[]) =>
      h.app.request(`/api/v1/collections/${col.id}/items`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ inputs }),
      });
    expect((await post(['https://youtu.be/cCPsdFdlshc'])).status).toBe(202);
    const big = await post(['https://youtu.be/cCPsdFdlshc', 'https://youtu.be/w8DxIwCbsVc']);
    expect(big.status).toBe(413);
    expect((await big.json()).error).toMatchObject({ code: 'too-large', message: expect.stringContaining('at most 2 videos') });
  });
});

describe('anonymous access and abuse protection', () => {
  const anonEnv = { VID2CONTEXT_ANONYMOUS: '1', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' };

  it('needs a Turnstile token on routes that can start speech-to-text, validated with siteverify', async () => {
    const h = harness(anonEnv);
    const url = `/api/v1/context?url=${encodeURIComponent(APOLLO)}&mode=stt`;
    const missing = await get(h, url);
    expect(missing.status).toBe(403);
    expect((await missing.json()).error.message).toContain('missing-input-response');
    expect(h.fetch.calls).toHaveLength(0);

    const ok = await get(h, url, { 'x-turnstile-token': 'XXXX.DUMMY.TOKEN.XXXX' });
    expect(ok.status).toBe(200);
    const verify = h.fetch.calls.find((c) => c.url === TURNSTILE_VERIFY_URL);
    const form = new URLSearchParams(String(verify?.body));
    expect(form.get('secret')).toBe('1x0000000000000000000000000000000AA');
    expect(form.get('response')).toBe('XXXX.DUMMY.TOKEN.XXXX');
    expect(form.get('remoteip')).toBe('203.0.113.7');

    // Read-only routes and captions-only requests skip the challenge.
    const before = h.fetch.calls.length;
    expect((await get(h, '/api/v1/metadata')).status).toBe(200);
    // A local file has no captions, so this ends in 422, but it never asks for a Turnstile token.
    expect((await get(h, `/api/v1/context?url=${encodeURIComponent(APOLLO)}&mode=captions`)).status).toBe(422);
    expect(h.fetch.calls.slice(before).some((c) => c.url === TURNSTILE_VERIFY_URL)).toBe(false);
  });

  it('refuses failed and redeemed tokens (recorded with the always-fail and duplicate test secrets)', async () => {
    for (const [secret, code] of [
      ['2x0000000000000000000000000000000AA', 'invalid-input-response'],
      ['3x0000000000000000000000000000000AA', 'timeout-or-duplicate'],
    ]) {
      const h = harness({ ...anonEnv, TURNSTILE_SECRET: secret });
      const res = await get(h, `/api/v1/context?url=${encodeURIComponent(APOLLO)}`, { 'x-turnstile-token': 'XXXX.DUMMY.TOKEN.XXXX' });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatchObject({ code: 'auth', message: expect.stringContaining(code) });
    }
  });

  it('turns anonymous transcription off when no Turnstile secret is set', async () => {
    const h = harness({ VID2CONTEXT_ANONYMOUS: '1' });
    const res = await get(h, `/api/v1/context?url=${encodeURIComponent(APOLLO)}`);
    expect(res.status).toBe(403);
    expect((await res.json()).error.hint).toContain('mode=captions');
  });

  it('limits anonymous callers per IP on the anonymous plan', async () => {
    const h = harness({ ...anonEnv, VID2CONTEXT_PLANS: '{"anonymous":{"requestsPerDay":1}}' });
    expect((await get(h, '/api/v1/metadata')).status).toBe(200);
    const second = await get(h, '/api/v1/metadata');
    expect(second.status).toBe(429);
    expect((await second.json()).error.message).toContain('of the anonymous plan');
    expect((await get(h, '/api/v1/metadata', { 'x-test-ip': '198.51.100.9' })).status).toBe(200);
    // Usage is keyed by a hash of the IP, never the IP itself.
    const keys = (await h.kv.kvList('accounts:usage:')).keys;
    expect(keys).toHaveLength(2);
    expect(keys.join()).not.toMatch(/203\.0\.113|198\.51\.100/);
  });

  it('puts a per-IP token bucket in front of everything except the exempt routes', async () => {
    const h = harness({ VID2CONTEXT_IP_BURST: '2', VID2CONTEXT_IP_PER_MINUTE: '1' });
    const { cookie } = await h.signIn();
    expect((await get(h, '/api/v1/metadata', { cookie })).status).toBe(200);
    expect((await get(h, '/api/v1/metadata', { cookie })).status).toBe(200);
    const limited = await get(h, '/api/v1/metadata', { cookie });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await limited.json()).error.message).toBe('Too many requests from this address.');
    expect((await get(h, '/api/v1/health')).status).toBe(200);
    expect((await get(h, '/api/v1/metadata', { cookie, 'x-test-ip': '198.51.100.9' })).status).toBe(200);
    h.clock.now += 60_000;
    expect((await get(h, '/api/v1/metadata', { cookie })).status).toBe(200);
  });
});

describe('canTriggerStt', () => {
  it('treats read-only routes and captions mode as safe, everything else as able to transcribe', () => {
    expect(canTriggerStt('GET', '/context', undefined)).toBe(true);
    expect(canTriggerStt('GET', '/transcript', 'auto')).toBe(true);
    expect(canTriggerStt('GET', '/transcript', 'captions')).toBe(false);
    expect(canTriggerStt('POST', '/jobs', undefined)).toBe(true);
    expect(canTriggerStt('GET', '/jobs/abc', undefined)).toBe(false);
    expect(canTriggerStt('GET', '/jobs/abc/events', undefined)).toBe(false);
    expect(canTriggerStt('GET', '/metadata', undefined)).toBe(false);
    expect(canTriggerStt('GET', '/library/youtube%3Ax', undefined)).toBe(false);
    expect(canTriggerStt('GET', '/metadataX', undefined)).toBe(true);
    expect(canTriggerStt('POST', '/collections/c1/items', undefined)).toBe(true);
    expect(canTriggerStt('DELETE', '/collections/c1', undefined)).toBe(false);
    expect(canTriggerStt('GET', '/some-new-route', undefined)).toBe(true);
  });
});
