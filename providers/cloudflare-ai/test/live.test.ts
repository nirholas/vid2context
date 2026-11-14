/**
 * LIVE=1 checks against real Workers AI. Needs CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_API_TOKEN in the environment (for example `set -a; . ./.env`).
 *
 *   REST     Whisper on the Apollo clip and bge-m3 embeddings, straight from Node.
 *   binding  The same models through env.AI in the test Worker (test/worker), run
 *            with `wrangler dev`, which always sends AI calls to Cloudflare.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext } from '@vid2context/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embedRungs, sttRungs } from '../src/index.ts';

const apollo = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url)));
const live = Boolean(process.env.LIVE && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);

describe.skipIf(!live)('Workers AI over REST (live)', () => {
  const ctx = () => createContext({ runtime: 'node', env: process.env });

  it('transcribes the Apollo clip with whisper-large-v3-turbo', async () => {
    const rung = sttRungs(process.env).find((r) => r.id === 'stt/cloudflare/@cf/openai/whisper-large-v3-turbo');
    const res = await rung?.transcribe(
      { kind: 'bytes', data: apollo, mimeType: 'audio/mpeg', filename: 'apollo.mp3' },
      {},
      ctx(),
    );
    expect(res?.language).toBe('en');
    expect(res?.segments.map((s) => s.text).join(' ')).toMatch(/small step for man/i);
  });

  it('embeds with bge-m3', async () => {
    const rung = embedRungs(process.env).find((r) => r.id === 'embed/cloudflare/@cf/baai/bge-m3');
    const vectors = await rung?.embed(['one small step for man'], ctx());
    expect(vectors?.[0]).toHaveLength(1024);
  });
});

describe.skipIf(!live)('Workers AI through the AI binding in wrangler dev (live)', () => {
  const port = 20000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  let proc: ChildProcess | undefined;

  beforeAll(async () => {
    const config = fileURLToPath(new URL('./worker/wrangler.jsonc', import.meta.url));
    // Its own process group, so afterAll can stop wrangler and the workerd processes it starts.
    proc = spawn('npx', ['wrangler', 'dev', '--config', config, '--port', String(port), '--ip', '127.0.0.1'], {
      env: process.env,
      stdio: 'ignore',
      detached: true,
    });
    for (let i = 0; i < 90; i++) {
      try {
        const res = await fetch(`${base}/bindings`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('wrangler dev did not start');
  }, 120_000);

  afterAll(() => {
    if (proc?.pid) process.kill(-proc.pid, 'SIGTERM');
  });

  it('hands the AI binding to providers as ctx.bindings', async () => {
    const res = (await (await fetch(`${base}/bindings`)).json()) as { bindings: string[]; env: string[] };
    expect(res.bindings).toEqual(['AI']);
    expect(res.env).toEqual(['CLOUDFLARE_AI_BINDING']);
  });

  it('transcribes with whisper-large-v3-turbo through the binding', async () => {
    const res = (await (await fetch(`${base}/stt`, { method: 'POST', body: apollo })).json()) as { segments: { text: string }[] };
    expect(res.segments.map((s) => s.text).join(' ')).toMatch(/small step for man/i);
  });

  it('transcribes with legacy whisper through the binding', async () => {
    const res = (await (await fetch(`${base}/stt?model=@cf/openai/whisper`, { method: 'POST', body: apollo })).json()) as {
      segments: { text: string }[];
    };
    expect(res.segments.length).toBeGreaterThan(0);
  });

  it('answers in JSON mode and streams through the binding', async () => {
    const chat = (await (await fetch(`${base}/chat?json`)).json()) as { text: string };
    expect(JSON.parse(chat.text)).toMatchObject({ speaker: 'Neil Armstrong', year: 1969 });
    const events = (await (await fetch(`${base}/stream?json`)).json()) as { type: string }[];
    expect(events.filter((e) => e.type === 'delta').length).toBeGreaterThan(1);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('embeds through the binding', async () => {
    const res = (await (await fetch(`${base}/embed`)).json()) as { lengths: number[] };
    expect(res.lengths).toEqual([1024, 1024]);
  });

  it('maps an unknown model to not-found', async () => {
    const res = (await (
      await fetch(`${base}/stt?model=@cf/openai/whisper-does-not-exist`, { method: 'POST', body: apollo })
    ).json()) as {
      error: { code: string };
    };
    expect(res.error.code).toBe('not-found');
  });
});
