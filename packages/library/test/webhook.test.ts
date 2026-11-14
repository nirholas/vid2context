import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SIGNATURE_HEADER, signBody, TIMESTAMP_HEADER, verifySignature, type WebhookPayload } from '../src/index.ts';
import { GWAGON, PLAYLIST, setup } from './helpers.ts';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A real HTTP receiver on 127.0.0.1 and a random port from 20000 to 29999 that answers with the given statuses in turn. */
async function receiver(statuses: number[]): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  let i = 0;
  for (let tries = 0; tries < 20; tries++) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = statuses[Math.min(i++, statuses.length - 1)] ?? 200;
        res.end();
      });
    });
    const ok = await new Promise<boolean>((resolve) => {
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      server = s;
      return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/hooks/vid2context`, received };
    }
  }
  throw new Error('no free port');
}

const SECRET = 'test-signing-secret';

describe('signatures', () => {
  it('signs the raw body with HMAC-SHA256 as sha256=<hex>, matching node:crypto', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    expect(await signBody(body, SECRET)).toBe(expected);
    expect(await verifySignature(body, SECRET, expected)).toBe(true);
    expect(await verifySignature(`${body} `, SECRET, expected)).toBe(false);
    expect(await verifySignature(body, 'other', expected)).toBe(false);
    expect(await verifySignature(body, SECRET, null)).toBe(false);
  });
});

describe('refresh webhooks', () => {
  it('POSTs new items with a valid signature and retries after a 503', async () => {
    const hook = await receiver([503, 200]);
    const { lib } = setup({
      env: { VID2CONTEXT_WEBHOOK_URL: hook.url, VID2CONTEXT_WEBHOOK_SECRET: SECRET },
      library: { webhook: { baseDelayMs: 10 } },
    });
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    const summary = await lib.refresh(c.id, { delayMs: 0 });
    const [result] = await lib.flush();
    expect(result).toEqual({ delivered: true, attempts: 2, status: 200 });
    expect(hook.received).toHaveLength(2);

    const last = hook.received[1] as Received;
    const expected = `sha256=${createHmac('sha256', SECRET).update(last.body).digest('hex')}`;
    expect(last.headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expected);
    expect(Number(last.headers[TIMESTAMP_HEADER.toLowerCase()])).toBeGreaterThan(1_700_000_000);
    expect(last.headers['content-type']).toBe('application/json');
    const payload = JSON.parse(last.body) as WebhookPayload;
    expect(payload.collection).toEqual({ id: c.id, name: 'G-Wagon' });
    expect(payload.added.map((a) => a.id)).toEqual([GWAGON]);
    expect(payload.checkedAt).toBe(summary.checkedAt);
    expect(hook.received[0]?.body).toBe(last.body);
  });

  it('sends nothing when a refresh adds nothing', async () => {
    const hook = await receiver([200]);
    const { lib } = setup({ env: { VID2CONTEXT_WEBHOOK_URL: hook.url, VID2CONTEXT_WEBHOOK_SECRET: SECRET } });
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    await lib.refresh(c.id, { delayMs: 0 });
    await lib.flush();
    await lib.refresh(c.id, { delayMs: 0 });
    expect(await lib.flush()).toEqual([]);
    expect(hook.received).toHaveLength(1);
  });

  it('does not retry a 4xx, and a dead receiver never fails the refresh', async () => {
    const hook = await receiver([400]);
    const { lib } = setup({
      env: { VID2CONTEXT_WEBHOOK_URL: hook.url, VID2CONTEXT_WEBHOOK_SECRET: SECRET },
      library: { webhook: { baseDelayMs: 10 } },
    });
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    await lib.refresh(c.id, { delayMs: 0 });
    expect(await lib.flush()).toEqual([{ delivered: false, attempts: 1, status: 400 }]);
    expect(hook.received).toHaveLength(1);

    const port = Number(new URL(hook.url).port);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const dead = setup({
      env: { VID2CONTEXT_WEBHOOK_URL: `http://127.0.0.1:${port}/gone`, VID2CONTEXT_WEBHOOK_SECRET: SECRET },
      library: { webhook: { baseDelayMs: 5, attempts: 3 } },
    });
    const c2 = await dead.lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    const s = await dead.lib.refresh(c2.id, { delayMs: 0 });
    expect(s.added.map((a) => a.id)).toEqual([GWAGON]);
    const [r] = await dead.lib.flush();
    expect(r?.delivered).toBe(false);
    expect(r?.attempts).toBe(3);
    expect(r?.error).toBeTruthy();
  });
});
