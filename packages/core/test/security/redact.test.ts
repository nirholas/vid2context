/**
 * Key samples below are format samples, not real credentials: each is built
 * from its documented prefix plus a repeated filler of the documented length,
 * so it has the right shape for the redactor without being anyone's key (and
 * without tripping repository secret scanners).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import llm from '../../../../providers/llm-openai-compatible/src/index.ts';
import { runChain } from '../../src/chain.ts';
import { chat } from '../../src/pipeline.ts';
import { Registry } from '../../src/registry.ts';
import { REDACTED, redact } from '../../src/security/index.ts';
import { testContext } from '../../src/testing.ts';

const fill = (n: number, c = 'x') => c.repeat(n);
const SAMPLES: Record<string, string> = {
  openai: `sk-${fill(48)}`,
  openaiProject: `sk-proj-${fill(64, 'A')}`,
  anthropic: `sk-ant-api03-${fill(80, 'B')}`,
  groq: `gsk_${fill(52, 'C')}`,
  google: `AIza${fill(35, 'D')}`,
  githubClassic: `gh${'p'}_${fill(36, 'E')}`,
  githubOauth: `gh${'o'}_${fill(36, 'F')}`,
  githubFine: `github_${'pat'}_${fill(22, 'G')}_${fill(59, 'H')}`,
  huggingFace: `hf_${fill(34, 'I')}`,
  xai: `xai-${fill(80, 'J')}`,
};

describe('redact: strings', () => {
  for (const [name, key] of Object.entries(SAMPLES)) {
    it(`redacts a ${name} key shape in text`, () => {
      const out = redact(`groq stt: HTTP 401 invalid key ${key} (check your settings)`);
      expect(out).not.toContain(key);
      expect(out).toContain(REDACTED);
      expect(out).toContain('(check your settings)');
    });
  }

  it('redacts Bearer tokens and header lines dumped into a message', () => {
    const out = redact('request failed; headers: Authorization: Bearer abc.def-123456789\nX-Api-Key: plainvalue123');
    expect(out).not.toContain('abc.def-123456789');
    expect(out).not.toContain('plainvalue123');
  });

  it('redacts secret query parameters and keeps the rest of the URL', () => {
    const out = redact('GET https://www.googleapis.com/youtube/v3/videos?part=snippet&key=SECRETVALUE1234&id=jNQXAC9IVRw');
    expect(out).toBe(`GET https://www.googleapis.com/youtube/v3/videos?part=snippet&key=${REDACTED}&id=jNQXAC9IVRw`);
    expect(redact('https://cdn.example/a.mp3?sig=abcdef123&token=zzzzzzzz')).toBe(
      `https://cdn.example/a.mp3?sig=${REDACTED}&token=${REDACTED}`,
    );
  });

  it('redacts passwords in URL userinfo', () => {
    expect(redact('cannot fetch https://me:hunter2hunter2@llm.example/v1')).toBe(
      `cannot fetch https://me:${REDACTED}@llm.example/v1`,
    );
  });

  it('redacts literal values of secret env vars, including pooled keys', () => {
    const env = {
      DEEPGRAM_API_KEY: 'a1b2c3d4e5f6a7b8c9d0',
      GROQ_API_KEYS: 'firstpooledkey01, secondpooledkey02',
      HF_TOKEN: 'plain-token-value-99',
      YT_COOKIE: 'SID=abcdefghijkl',
      VID2CONTEXT_LOG_LEVEL: 'debug-verbose-mode',
    };
    const out = redact(
      'deepgram a1b2c3d4e5f6a7b8c9d0 / secondpooledkey02 / plain-token-value-99 / SID=abcdefghijkl / debug-verbose-mode',
      env,
    );
    expect(out).toBe(`deepgram ${REDACTED} / ${REDACTED} / ${REDACTED} / ${REDACTED} / debug-verbose-mode`);
  });

  it('does not redact env values shorter than 8 characters', () => {
    const env = { OPENAI_API_KEY: 'video', ADMIN_PASSWORD: 'the' };
    expect(redact('the video was found', env)).toBe('the video was found');
  });

  it('leaves ordinary text alone', () => {
    const s = 'Every stt rung failed (3 tried). See attempts; skipped: cooldown, too-large 30000000 > 25000000 bytes.';
    expect(redact(s, { GROQ_API_KEY: SAMPLES.groq })).toBe(s);
  });
});

describe('redact: objects', () => {
  it('redacts header objects and Headers instances', () => {
    const h = { Authorization: `Bearer ${SAMPLES.openai}`, 'x-api-key': 'k', Accept: 'application/json', Cookie: 'a=b' };
    expect(redact(h)).toEqual({ Authorization: REDACTED, 'x-api-key': REDACTED, Accept: 'application/json', Cookie: REDACTED });
    const hs = new Headers({ authorization: 'Bearer zzzzzzzzzz', 'set-cookie': 'sid=1', 'content-type': 'text/plain' });
    expect(redact(hs)).toEqual({ authorization: REDACTED, 'set-cookie': REDACTED, 'content-type': 'text/plain' });
  });

  it('redacts nested attempts and secret-named fields deeply without changing the input', () => {
    const input = {
      attempts: [
        { id: 'groq:whisper-large-v3', outcome: 'error', detail: `HTTP 401 key ${SAMPLES.groq}` },
        { id: 'openai:gpt-4o-mini-transcribe', outcome: 'ok' },
      ],
      config: { apiKey: 'anything', OPENAI_API_KEY: 'whatever', nested: { client_secret: 's', note: 'fine' } },
      requires: ['GROQ_API_KEY'],
    };
    const copy = structuredClone(input);
    const out = redact(input);
    expect(out.attempts[0]?.detail).toBe(`HTTP 401 key ${REDACTED}`);
    expect(out.config).toEqual({ apiKey: REDACTED, OPENAI_API_KEY: REDACTED, nested: { client_secret: REDACTED, note: 'fine' } });
    expect(out.requires).toEqual(['GROQ_API_KEY']);
    expect(input).toEqual(copy);
  });

  it('is cycle-safe', () => {
    const a: Record<string, unknown> = { name: 'a', token: 'abc' };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.self).toBe('[circular]');
    expect(out.token).toBe(REDACTED);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('turns errors into plain objects with a redacted message', () => {
    const out = redact({ err: new Error(`failed with ${SAMPLES.anthropic}`) }) as { err: { name: string; message: string } };
    expect(out.err).toEqual({ name: 'Error', message: `failed with ${REDACTED}` });
  });
});

describe('redaction wired into the core', () => {
  it('runChain redacts the env key in attempt details', async () => {
    const env = { MY_SERVICE_API_KEY: 'q8w7e6r5t4y3u2i1o0p9' };
    const ctx = testContext({ env });
    const rung = {
      id: 'llm/my-service/model',
      provider: 'test',
      service: 'my-service',
      model: 'model',
      tier: 'free' as const,
      priority: 1,
      quality: 1,
      capabilities: [],
      requires: ['MY_SERVICE_API_KEY'],
    };
    const err = await runChain(
      'llm',
      [rung],
      async () => {
        // A real fetch error: the URL carries the key the way some APIs take it (?key=), and
        // replayFetch throws because nothing is recorded for it.
        await ctx.fetch(`https://api.my-service.example/v1/models?key=${env.MY_SERVICE_API_KEY}`);
      },
      {},
      ctx,
    ).catch((e) => e);
    const detail = err.attempts[0].detail as string;
    expect(detail).not.toContain(env.MY_SERVICE_API_KEY);
    expect(detail).toContain(REDACTED);
  });

  it('a real provider whose base URL embeds a key gets a redacted attempt detail', async () => {
    const secret = `gsk_${fill(52, 'Z')}`;
    const env = {
      LOCAL_LLM_BASE_URL: `https://vid2context:${secret}@llm.example/v1`,
      LOCAL_LLM_MODEL: 'llama3.2',
      LOCAL_LLM_API_KEY: secret,
      VID2CONTEXT_KEYLESS: '0',
    };
    // Node's own fetch refuses URLs with credentials and repeats the full URL in its error,
    // before any connection is made.
    const ctx = testContext({ env, fetch: globalThis.fetch.bind(globalThis) });
    const registry = new Registry([llm], 'node');
    const err = await chat(registry, { messages: [{ role: 'user', content: 'hi' }] }, { policy: 'local-only' }, ctx).catch(
      (e) => e,
    );
    expect(err.code).toBe('all-rungs-failed');
    const detail = err.attempts[0].detail as string;
    expect(detail).toContain('includes credentials');
    expect(detail).not.toContain(secret);
    expect(detail).toContain(REDACTED);
  });

  it('stderrLogger redacts messages and data (real stderr of a child process)', () => {
    const key = `sk-proj-${fill(40, 'K')}`;
    const contextPath = fileURLToPath(new URL('../../src/context.ts', import.meta.url));
    const script = `
      import { createContext } from ${JSON.stringify(contextPath)};
      const ctx = createContext({ runtime: 'node', env: { OPENAI_API_KEY: process.env.K, VID2CONTEXT_LOG_LEVEL: 'info' } });
      ctx.log.warn('openai failed with key ' + process.env.K, { headers: { authorization: 'Bearer ' + process.env.K }, url: 'https://x.example/?api_key=' + process.env.K });
      process.stdout.write('stdout-clean');
    `;
    const tsx = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));
    const run = spawnSync(tsx, ['--input-type=module', '-e', script], {
      env: { ...process.env, K: key },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('stdout-clean');
    expect(run.stderr).toContain('[vid2context] warn: openai failed with key [redacted]');
    expect(run.stderr).not.toContain(key);
    expect(run.stderr).not.toContain('KKKKKKKK');
  });
});
