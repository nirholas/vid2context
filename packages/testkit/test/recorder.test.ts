/**
 * Recorder tests. The scrubbing tests record real HTTP exchanges with a
 * node:http echo server started here (it answers with the request it saw, so
 * every secret we send comes straight back in the response too) and check that
 * no secret reaches disk. The LIVE test records the keyless OVH endpoints.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { llmRungs } from '@vid2context/provider-llm-openai-compatible';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyShapedValue } from '../src/invariants.ts';
import { fixtureRoutes, readRecorded, recordingFetch } from '../src/recorder.ts';
import { isIp, isRoutableIp, Scrubber } from '../src/scrub.ts';

let server: Server;
let base: string;
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vid2context-testkit-'));
  dirs.push(d);
  return d;
}

function allText(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const echoed = JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body });
      const auth = req.headers.authorization ?? '';
      res.writeHead(req.url?.startsWith('/limited') ? 429 : 200, {
        'content-type': 'application/json',
        'retry-after': req.url?.startsWith('/limited') ? '7' : '',
        'set-cookie': `session=${auth.replace('Bearer ', '')}; HttpOnly`,
        'x-ratelimit-remaining-requests': '41',
        'x-request-id': 'not-allowlisted',
      });
      res.end(echoed);
    });
  });
  const port = 20000 + Math.floor(Math.random() * 10000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('recordingFetch scrubbing (local echo server)', () => {
  it('never writes a bearer token, cookie, key param, JSON key field or env secret to disk', async () => {
    const dir = tempDir();
    const bearer = keyShapedValue('GROQ_API_KEY');
    const queryKey = keyShapedValue('GEMINI_API_KEY');
    const bodyKey = keyShapedValue('OPENAI_API_KEY');
    const envOnly = `opaque${keyShapedValue('CUSTOM_SERVICE_TOKEN').slice(-24)}`;
    const env = { CUSTOM_SERVICE_TOKEN: envOnly, OTHER_FALLBACK_KEYS: `${keyShapedValue('X')},${keyShapedValue('Y')}` };
    const [pool1, pool2] = env.OTHER_FALLBACK_KEYS.split(',');
    const rec = recordingFetch(globalThis.fetch, { dir, name: 'echo', scrub: { env } });

    const res = await rec(`${base}/v1/chat?key=${queryKey}&model=m1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        cookie: `sid=${bearer}`,
        'content-type': 'application/json',
        'x-custom': envOnly,
      },
      body: JSON.stringify({ api_key: bodyKey, prompt: `use ${envOnly} and ${pool1}`, nested: { token: pool2 } }),
    });
    // The caller still gets the real, unscrubbed response.
    const live = (await res.json()) as { headers: Record<string, string> };
    expect(live.headers.authorization).toBe(`Bearer ${bearer}`);

    const disk = allText(dir);
    for (const secret of [bearer, queryKey, bodyKey, envOnly, pool1, pool2]) {
      expect(secret && disk.includes(secret), `a secret reached disk: ${secret?.slice(0, 6)}...`).toBe(false);
    }
    const exchange = readRecorded(dir, { name: 'echo' })[0]?.exchange;
    if (!exchange) throw new Error('nothing was recorded');
    expect(exchange.request.headers.authorization).toBe('[redacted]');
    expect(exchange.request.headers.cookie).toBe('[redacted]');
    expect(exchange.request.headers['x-custom']).toBeUndefined();
    expect(exchange.request.url).toBe(`${base}/v1/chat?key=REDACTED&model=m1`);
    expect(JSON.parse(exchange.request.body ?? '{}')).toMatchObject({ api_key: '[redacted]', nested: { token: '[redacted]' } });
    expect(exchange.response.headers).toEqual({
      'content-type': 'application/json',
      'retry-after': '',
      'set-cookie': '[redacted]',
      'x-ratelimit-remaining-requests': '41',
    });
    const whats = rec.report().findings.map((f) => f.what);
    expect(whats).toEqual(expect.arrayContaining(['header:authorization', 'header:cookie', 'param:key', 'json-field:api_key']));
  });

  it('strips IP-bearing params from media stream URLs and warns about them', async () => {
    const dir = tempDir();
    // 203.0.113.0/24 is the TEST-NET-3 documentation range (RFC 5737), never a real host.
    const stream = 'https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&ip=203.0.113.7&ipbits=0&sig=AOq0QJ8w&itag=140';
    const rec = recordingFetch(globalThis.fetch, { dir, name: 'stream' });
    await rec(`${base}/player`, { method: 'POST', body: JSON.stringify({ streamingData: { url: stream } }) });
    const disk = allText(dir);
    expect(disk).not.toContain('203.0.113.7');
    expect(disk).not.toContain('AOq0QJ8w');
    expect(disk).toContain('itag=140');
    expect(rec.report().warnings.some((w) => w.includes('IP address'))).toBe(true);
  });

  it('replays recorded files through fixtureRoutes to the same parsed results, in order for repeated URLs', async () => {
    const dir = tempDir();
    const rec = recordingFetch(globalThis.fetch, { dir, name: 'seq' });
    const live: unknown[] = [];
    for (const path of ['/a?n=1', '/b', '/a?n=1', '/limited']) {
      const r = await rec(`${base}${path}`, {
        method: path === '/b' ? 'POST' : 'GET',
        body: path === '/b' ? 'second' : undefined,
      });
      live.push({ status: r.status, retry: r.headers.get('retry-after'), json: await r.json() });
    }
    expect(rec.files.map((f) => f.split('/').pop())).toEqual(['seq-001.json', 'seq-002.json', 'seq-003.json', 'seq-004.json']);

    const replay = replayFetch(fixtureRoutes(dir, { name: 'seq' }));
    const replayed: unknown[] = [];
    for (const path of ['/a?n=1', '/b', '/a?n=1', '/limited']) {
      const r = await replay(`${base}${path}`, { method: path === '/b' ? 'POST' : 'GET' });
      replayed.push({ status: r.status, retry: r.headers.get('retry-after'), json: await r.json() });
    }
    expect(replayed).toEqual(live);
    await expect(replay(`${base}/never-recorded`)).rejects.toThrow(/no recorded response/);
  });

  it('matches a scrubbed URL against the real one on replay', async () => {
    const dir = tempDir();
    const key = keyShapedValue('GEMINI_API_KEY');
    const rec = recordingFetch(globalThis.fetch, { dir, name: 'keyed' });
    const live = (await (await rec(`${base}/v1/models?key=${key}`)).json()) as { url: string };
    expect(live.url).toContain(key);
    // A different key on replay still matches the recorded (scrubbed) URL; the echoed key was scrubbed from the body too.
    const replay = replayFetch(fixtureRoutes(dir));
    const again = (await (await replay(`${base}/v1/models?key=${keyShapedValue('GEMINI_API_KEY')}`)).json()) as { url: string };
    expect(again.url).toBe('/v1/models?key=[redacted]');
    expect(allText(dir)).not.toContain(key);
  });
});

describe('Scrubber', () => {
  it('replaces known key shapes anywhere in text', () => {
    const s = new Scrubber();
    const shapes = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN', 'HF_TOKEN'].map(
      keyShapedValue,
    );
    const out = s.text(`keys: ${shapes.join(' ')} github_pat_${'a1'.repeat(20)}`, 'request.body');
    for (const k of shapes) expect(out).not.toContain(k);
    expect(out).not.toContain('github_pat_a1');
    expect(
      s
        .report()
        .findings.map((f) => f.what)
        .sort(),
    ).toEqual(
      ['anthropic-key', 'github-pat', 'github-token', 'google-key', 'groq-key', 'huggingface-token', 'openai-key'].sort(),
    );
  });

  it('scrubs account ids from env, and a bare "key" field only when it looks like a credential', () => {
    const accountId = '0123456789abcdef0123456789abcdef'.split('').reverse().join('');
    const s = new Scrubber({ env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
    expect(s.url(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/openai/whisper`)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/REDACTED/ai/run/@cf/openai/whisper',
    );
    const body = JSON.stringify({ params: [{ key: 'cver', value: '20.10.38' }], auth: { key: keyShapedValue('SERVICE_KEY') } });
    const out = JSON.parse(s.body(body, 'response.body')) as { params: { key: string }[]; auth: { key: string } };
    expect(out.params[0]?.key).toBe('cver');
    expect(out.auth.key).toBe('[redacted]');
  });

  it('scrubs a routable IP from any URL in a body and keeps the 0.0.0.0 placeholder', () => {
    // The caption URL shape from a real player response (recorded 2026-11-15), with a TEST-NET-3 address put in.
    const url = (ip: string) =>
      `https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw\\u0026hl=en\\u0026ip=${ip}\\u0026ipbits=0\\u0026lang=en`;
    const s = new Scrubber();
    const out = s.body(`{"baseUrl":"${url('203.0.113.7')}","other":"${url('0.0.0.0')}"}`, 'response.body');
    expect(out).not.toContain('203.0.113.7');
    expect(out).toContain('ip=REDACTED');
    expect(out).toContain('ip=0.0.0.0');
    expect(isRoutableIp('192.168.1.4')).toBe(false);
    expect(isRoutableIp('::1')).toBe(false);
    expect(isRoutableIp('2001:db8::1')).toBe(true);
    expect(s.report().findings.map((f) => f.what)).toContain('url-ip');
  });

  it('recognises IP addresses but not clock times or versions', () => {
    expect(isIp('203.0.113.7')).toBe(true);
    expect(isIp('2001:db8::1')).toBe(true);
    expect(isIp('12:30:00')).toBe(false);
    expect(isIp('20.10.38')).toBe(false);
    expect(isIp('999.1.1.1')).toBe(false);
  });
});

const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';

describe('recorded keyless OVH exchanges (test/fixtures/ovh)', () => {
  const dir = join(import.meta.dirname, 'fixtures', 'ovh');
  it('replays the recorded model list and chat completion through fixtureRoutes', async () => {
    const replay = replayFetch(fixtureRoutes(dir, { name: 'ovh' }));
    const models = (await (await replay(`${OVH}/models`)).json()) as { data: { id: string }[] };
    expect(models.data.some((m) => m.id === 'Meta-Llama-3_3-70B-Instruct')).toBe(true);
    const rung = llmRungs({}).find((r) => r.id === 'llm/ovh/Meta-Llama-3_3-70B-Instruct');
    const res = await rung?.chat(
      {
        messages: [{ role: 'user', content: 'In which year did Apollo 11 land on the Moon? Answer with the year only.' }],
        maxTokens: 20,
      },
      testContext({ fetch: replay }),
    );
    expect(res?.text).toMatch(/1969/);
  });
});

describe.skipIf(!process.env.LIVE)('recordingFetch against keyless OVH (live)', () => {
  it('records GET /v1/models and one chat completion, then replays them to identical results', async () => {
    const dir = tempDir();
    const rec = recordingFetch(globalThis.fetch, { dir, name: 'ovh', scrub: { env: process.env } });
    const ctx = createContext({ runtime: 'node', env: {}, fetch: rec });
    const models = await (await ctx.fetch(`${OVH}/models`)).json();
    const rung = llmRungs({}).find((r) => r.id === 'llm/ovh/Meta-Llama-3_3-70B-Instruct');
    if (!rung) throw new Error('OVH rung missing');
    const req = {
      messages: [{ role: 'user' as const, content: 'In which year did Apollo 11 land on the Moon? Answer with the year only.' }],
      maxTokens: 20,
    };
    const live = await rung.chat(req, ctx);
    expect(rec.files).toHaveLength(2);

    const replay = replayFetch(fixtureRoutes(dir, { name: 'ovh' }));
    expect(await (await replay(`${OVH}/models`)).json()).toEqual(models);
    expect(await rung.chat(req, testContext({ fetch: replay }))).toEqual(live);
  });
});
