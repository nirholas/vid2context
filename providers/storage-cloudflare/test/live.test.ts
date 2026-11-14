/**
 * LIVE=1: the storage inside a real Worker in `wrangler dev` (local D1, R2 and
 * KV under workerd, no account needed). Applies migrations/ with
 * `wrangler d1 migrations apply --local`, saves the shared fixture contexts
 * through the Worker and finds them again by search.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const config = fileURLToPath(new URL('./worker/wrangler.jsonc', import.meta.url));
const fixture = (file: string) => readFileSync(new URL(`../../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8');

describe.skipIf(!process.env.LIVE)('D1 storage in wrangler dev (live)', () => {
  const port = 20000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  const persist = mkdtempSync(join(tmpdir(), 'vid2context-d1-'));
  let proc: ChildProcess | undefined;

  beforeAll(async () => {
    execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', persist], {
      stdio: 'ignore',
    });
    // Its own process group, so afterAll can stop wrangler and the workerd processes it starts.
    proc = spawn(
      'npx',
      ['wrangler', 'dev', '--config', config, '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist],
      {
        env: process.env,
        stdio: 'ignore',
        detached: true,
      },
    );
    for (let i = 0; i < 90; i++) {
      try {
        const res = await fetch(`${base}/list`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('wrangler dev did not start');
  }, 150_000);

  afterAll(() => {
    if (proc?.pid) process.kill(-proc.pid, 'SIGTERM');
    rmSync(persist, { recursive: true, force: true });
  });

  it('saves contexts through the Worker and finds them again by search', async () => {
    for (const file of ['youtube-jNQXAC9IVRw.json', 'youtube-cCPsdFdlshc.json']) {
      const res = await fetch(`${base}/save`, {
        method: 'POST',
        body: fixture(file),
        headers: { 'content-type': 'application/json' },
      });
      expect(await res.json()).toEqual({ ok: true, backend: 'cloudflare-d1' });
    }
    const hits = (await (await fetch(`${base}/search?q=elephants`)).json()) as { videoId: string; text: string }[];
    expect(hits).toEqual([
      expect.objectContaining({ videoId: 'youtube:jNQXAC9IVRw', text: 'All right, so here we are, in front of the elephants' }),
    ]);
    const trans = (await (await fetch(`${base}/search?q=transmission`)).json()) as { videoId: string }[];
    expect(trans.length).toBe(4);
    const list = (await (await fetch(`${base}/list`)).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id).sort()).toEqual(['youtube:cCPsdFdlshc', 'youtube:jNQXAC9IVRw']);
  });

  it('uses the KV namespace as a KvStore', async () => {
    const res = (await (await fetch(`${base}/kv`)).json()) as { value: unknown; keys: string[] };
    expect(res).toEqual({ value: { at: 'wrangler dev' }, keys: ['jobs:live'] });
  });
});
