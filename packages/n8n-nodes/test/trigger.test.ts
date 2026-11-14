import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { VideoContext } from '@vid2context/core';
import { collectionUpdatedData, emit, signedHeaders } from '@vid2context/webhooks';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../src/shared/signature.ts';
import { registerWebhook, unregisterWebhook, webhookExists } from '../src/shared/trigger.ts';
import { type ApiServer, fetchRequester, startApi } from './harness.ts';

// Real pipeline output (tests/fixtures/contexts, documented in its README).
const gwagon = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;

// Standard Webhooks published vector (github.com/standard-webhooks/standard-webhooks at 36afae79,
// libraries/javascript/src/webhook.test.ts and libraries/python/tests/test_webhooks.py).
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  msgId: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  payload: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

describe('trigger signature check', () => {
  it('matches the Standard Webhooks published vector', () => {
    expect(signPayload(VECTOR.secret, VECTOR.msgId, VECTOR.timestamp, VECTOR.payload)).toBe(VECTOR.signature);
    const headers = {
      'webhook-id': VECTOR.msgId,
      'webhook-timestamp': String(VECTOR.timestamp),
      'webhook-signature': VECTOR.signature,
    };
    expect(verifySignature(VECTOR.secret, headers, Buffer.from(VECTOR.payload), VECTOR.timestamp)).toEqual({ test: 2432232314 });
    expect(() => verifySignature(VECTOR.secret, headers, VECTOR.payload)).toThrow(/tolerance/);
    expect(() => verifySignature(VECTOR.secret, headers, '{"test": 1}', VECTOR.timestamp)).toThrow(/No webhook signature/);
    expect(() =>
      verifySignature(VECTOR.secret, { ...headers, 'webhook-id': undefined }, VECTOR.payload, VECTOR.timestamp),
    ).toThrow(/Missing/);
  });

  it('accepts what the official library and @vid2context/webhooks sign', async () => {
    const secret = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD';
    const body = '{"type":"brief.ready","timestamp":"2026-11-14T12:00:00.000Z","data":{"brief":{"id":"job_1","links":{}}}}';
    const now = new Date();
    const lib = {
      'webhook-id': 'msg_lib',
      'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
      'webhook-signature': new Webhook(secret).sign('msg_lib', now, body),
    };
    expect(verifySignature(secret, lib, body)).toMatchObject({ type: 'brief.ready' });
    const ours = await signedHeaders(secret, 'msg_ours', now.getTime() / 1000, body);
    expect(verifySignature(secret, { ...ours }, Buffer.from(body))).toMatchObject({ type: 'brief.ready' });
  });
});

describe('trigger lifecycle against a real vid2context server', () => {
  let api: ApiServer;
  let receiver: Server;
  let receiverUrl: string;
  const deliveries: { headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
  const request = fetchRequester();

  beforeAll(async () => {
    api = await startApi();
    // Stands in for n8n's webhook endpoint: keeps the raw body and headers exactly as received.
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        deliveries.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(20000 + Math.floor(Math.random() * 10000), '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhook/abc/webhook`;
  });

  afterAll(async () => {
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
    await api.close();
  });

  it('registers on activation, verifies a delivered event, and deletes on deactivation', async () => {
    const reg = await registerWebhook(request, api.base, {
      url: receiverUrl,
      events: ['collection.updated'],
      description: 'n8n workflow 1',
    });
    expect(reg.webhookId).toMatch(/^wh_/);
    expect(reg.secret).toMatch(/^whsec_/);
    expect(await webhookExists(request, api.base, reg)).toBe(true);
    // A registration for another URL (the workflow moved) does not count.
    expect(await webhookExists(request, api.base, { ...reg, url: `${receiverUrl}-old` })).toBe(false);

    const store = await api.stores(api.ctx);
    const realFetchCtx = { ...api.ctx, fetch: globalThis.fetch };
    const data = collectionUpdatedData(
      { id: 'g-wagon', name: 'G-Wagon', videoIds: [gwagon.metadata.ref.id] },
      { added: [gwagon] },
    );
    const result = await emit({ type: 'collection.updated', data }, store, realFetchCtx);
    expect(result.deliveries[0]).toMatchObject({ hookId: reg.webhookId, outcome: 'delivered' });

    const got = deliveries.at(-1);
    expect(got).toBeDefined();
    const payload = verifySignature(reg.secret, got?.headers ?? {}, got?.body ?? Buffer.alloc(0)) as {
      type: string;
      data: { added: { id: string }[] };
    };
    expect(payload.type).toBe('collection.updated');
    expect(payload.data.added[0]?.id).toBe('youtube:cCPsdFdlshc');
    // A forged delivery (right headers, changed body) is refused.
    expect(() => verifySignature(reg.secret, got?.headers ?? {}, Buffer.from('{"type":"collection.updated"}'))).toThrow();

    await unregisterWebhook(request, api.base, reg.webhookId);
    expect(await webhookExists(request, api.base, reg)).toBe(false);
    // Deactivating twice (the hook is already gone) is not an error.
    await expect(unregisterWebhook(request, api.base, reg.webhookId)).resolves.toBeUndefined();
  });

  it('refuses activation with no events, and the server refuses unknown ones', async () => {
    await expect(registerWebhook(request, api.base, { url: receiverUrl, events: [] })).rejects.toThrow(/at least one event/);
    await expect(registerWebhook(request, api.base, { url: receiverUrl, events: ['video.deleted'] })).rejects.toMatchObject({
      httpCode: '400',
    });
  });
});
