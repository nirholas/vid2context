import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { fromBase64, generateMessageId, generateSecret, sign, signedHeaders, verifyWebhook } from '../src/signing.ts';

// Known-answer vectors published by the Standard Webhooks project, from
// github.com/standard-webhooks/standard-webhooks at commit 36afae79 (main on
// 2026-11-14): libraries/javascript/src/webhook.test.ts ("sign function works",
// the binary payload signature that matches the Go library) and
// libraries/python/tests/test_webhooks.py (test_sign_function and the
// unpadded-secret cases).
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  msgId: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  payload: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const BINARY_PAYLOAD = Uint8Array.from({ length: 256 }, (_, i) => i);
const BINARY_SIGNATURE = 'v1,sEcZ042G8Crqgxbybb3y0eDxQR3TcfYsk11I1XULhSI=';

const vectorHeaders = {
  'webhook-id': VECTOR.msgId,
  'webhook-timestamp': String(VECTOR.timestamp),
  'webhook-signature': VECTOR.signature,
};

describe('Standard Webhooks published test vectors', () => {
  it('signs the reference message to the published signature', async () => {
    expect(await sign(VECTOR.secret, VECTOR.msgId, VECTOR.timestamp, VECTOR.payload)).toBe(VECTOR.signature);
  });

  it('signs a non-UTF-8 binary body byte for byte', async () => {
    expect(await sign(VECTOR.secret, VECTOR.msgId, VECTOR.timestamp, BINARY_PAYLOAD)).toBe(BINARY_SIGNATURE);
  });

  it('accepts the secret with or without the whsec_ prefix and without base64 padding', async () => {
    const bare = VECTOR.secret.slice('whsec_'.length);
    expect(await sign(bare, VECTOR.msgId, VECTOR.timestamp, VECTOR.payload)).toBe(VECTOR.signature);
    // The Python suite's one-pad and two-pad secrets: unpadded and padded give the same key.
    for (const [unpadded, padded] of [
      ['MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaS', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaS='],
      ['MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSwBr', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSwBr=='],
    ] as const) {
      expect(await sign(unpadded, VECTOR.msgId, VECTOR.timestamp, VECTOR.payload)).toBe(
        await sign(padded, VECTOR.msgId, VECTOR.timestamp, VECTOR.payload),
      );
    }
  });

  it('verifies the reference message at its own time and parses the payload', async () => {
    const parsed = await verifyWebhook<{ test: number }>(VECTOR.secret, vectorHeaders, VECTOR.payload, {
      nowSec: VECTOR.timestamp,
    });
    expect(parsed.test).toBe(2432232314);
  });

  it('rejects the reference message once it is older than the tolerance', async () => {
    await expect(verifyWebhook(VECTOR.secret, vectorHeaders, VECTOR.payload)).rejects.toMatchObject({ code: 'bad-request' });
    await expect(verifyWebhook(VECTOR.secret, vectorHeaders, VECTOR.payload, { nowSec: VECTOR.timestamp + 301 })).rejects.toThrow(
      /too old/,
    );
    await expect(verifyWebhook(VECTOR.secret, vectorHeaders, VECTOR.payload, { nowSec: VECTOR.timestamp - 301 })).rejects.toThrow(
      /future/,
    );
  });

  it('rejects a changed body, a missing header, a bad timestamp and an unknown version', async () => {
    const at = { nowSec: VECTOR.timestamp };
    await expect(verifyWebhook(VECTOR.secret, vectorHeaders, '{"test": 2432232315}', at)).rejects.toThrow(/No webhook signature/);
    const { 'webhook-id': _id, ...noId } = vectorHeaders;
    await expect(verifyWebhook(VECTOR.secret, noId, VECTOR.payload, at)).rejects.toThrow(/Missing/);
    await expect(
      verifyWebhook(VECTOR.secret, { ...vectorHeaders, 'webhook-timestamp': 'hello' }, VECTOR.payload, at),
    ).rejects.toThrow(/whole number/);
    const v2 = { ...vectorHeaders, 'webhook-signature': VECTOR.signature.replace('v1,', 'v2,') };
    await expect(verifyWebhook(VECTOR.secret, v2, VECTOR.payload, at)).rejects.toThrow(/No webhook signature/);
    await expect(verifyWebhook('whsec_', vectorHeaders, VECTOR.payload, at)).rejects.toThrow(/empty/);
  });

  it('accepts one valid signature among several and skips malformed ones (secret rotation)', async () => {
    const multi = {
      ...vectorHeaders,
      'webhook-signature': `v1 v1,not-base64! v2,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc= ${VECTOR.signature}`,
    };
    await expect(verifyWebhook(VECTOR.secret, multi, VECTOR.payload, { nowSec: VECTOR.timestamp })).resolves.toEqual({
      test: 2432232314,
    });
  });

  it('reads headers from a Headers object and from Node-style records with any case', async () => {
    const at = { nowSec: VECTOR.timestamp };
    await expect(verifyWebhook(VECTOR.secret, new Headers(vectorHeaders), VECTOR.payload, at)).resolves.toBeTruthy();
    const upper = {
      'Webhook-Id': VECTOR.msgId,
      'Webhook-Timestamp': String(VECTOR.timestamp),
      'Webhook-Signature': VECTOR.signature,
    };
    await expect(verifyWebhook(VECTOR.secret, upper, VECTOR.payload, at)).resolves.toBeTruthy();
  });
});

describe('interop with the official standardwebhooks library', () => {
  it('a webhook signed here verifies with the official library', async () => {
    const secret = generateSecret();
    const id = generateMessageId();
    const body = JSON.stringify({
      type: 'collection.updated',
      timestamp: new Date().toISOString(),
      data: { collection: { id: 'g-wagon' } },
    });
    const headers = await signedHeaders(secret, id, Date.now() / 1000, body);
    const parsed = new Webhook(secret).verify(body, { ...headers }) as { type: string };
    expect(parsed.type).toBe('collection.updated');
  });

  it('a webhook signed by the official library verifies here', async () => {
    const secret = generateSecret();
    const lib = new Webhook(secret);
    const id = generateMessageId();
    const now = new Date();
    const body = '{"type":"job.succeeded","timestamp":"2026-11-14T12:00:00.000Z","data":{"job":{"id":"j1"}}}';
    const headers = {
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
      'webhook-signature': lib.sign(id, now, body),
    };
    await expect(verifyWebhook(secret, headers, body)).resolves.toMatchObject({ type: 'job.succeeded' });
  });
});

describe('secrets and ids', () => {
  it('generates whsec_ secrets of 24 random bytes and message ids without dots', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(fromBase64(a.slice(6))).toHaveLength(24);
    expect(a).not.toBe(b);
    const id = generateMessageId();
    expect(id).toMatch(/^msg_[A-Za-z0-9_-]+$/);
    expect(id).not.toContain('.');
  });
});
