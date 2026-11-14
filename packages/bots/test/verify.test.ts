import { describe, expect, it } from 'vitest';
import { slackSignature, timingSafeEqual, verifyDiscord, verifySlack, verifyTelegram } from '../src/verify.ts';
import { discordKeys, fixtureJson, readFixture } from './util.ts';

// Slack's published example from "Verifying requests from Slack" (see fixtures/README.md).
const vector = fixtureJson<{ signingSecret: string; timestamp: string; body: string; signature: string }>(
  'slack-signing-vector.json',
);

describe('Slack request signing', () => {
  it("reproduces Slack's published signature", async () => {
    expect(await slackSignature(vector.signingSecret, vector.timestamp, vector.body)).toBe(vector.signature);
    expect(
      await verifySlack(vector.signingSecret, vector.signature, vector.timestamp, vector.body, Number(vector.timestamp)),
    ).toBe(true);
  });

  it('rejects a changed body, a wrong secret and a missing header', async () => {
    const at = Number(vector.timestamp);
    expect(await verifySlack(vector.signingSecret, vector.signature, vector.timestamp, `${vector.body}&x=1`, at)).toBe(false);
    expect(await verifySlack('another-secret', vector.signature, vector.timestamp, vector.body, at)).toBe(false);
    expect(await verifySlack(vector.signingSecret, undefined, vector.timestamp, vector.body, at)).toBe(false);
    expect(await verifySlack(vector.signingSecret, vector.signature, 'abc', vector.body, at)).toBe(false);
  });

  it('rejects timestamps more than five minutes away, in either direction', async () => {
    const at = Number(vector.timestamp);
    expect(await verifySlack(vector.signingSecret, vector.signature, vector.timestamp, vector.body, at + 300)).toBe(true);
    expect(await verifySlack(vector.signingSecret, vector.signature, vector.timestamp, vector.body, at + 301)).toBe(false);
    expect(await verifySlack(vector.signingSecret, vector.signature, vector.timestamp, vector.body, at - 301)).toBe(false);
    // The published example is from 2018, so against today's clock it is a replay.
    expect(
      await verifySlack(vector.signingSecret, vector.signature, vector.timestamp, vector.body, Math.floor(Date.now() / 1000)),
    ).toBe(false);
  });
});

describe('Discord Ed25519 verification', () => {
  // Discord publishes no test vectors, so a real key pair signs the documented interaction body.
  const body = readFixture('discord-interaction-command.json');
  const timestamp = '1794675828';

  it('accepts a valid signature over timestamp + body', async () => {
    const keys = await discordKeys();
    const sig = await keys.sign(timestamp, body);
    expect(await verifyDiscord(keys.publicKeyHex, sig, timestamp, body)).toBe(true);
  });

  it('rejects a changed body or timestamp, another key, and malformed input', async () => {
    const keys = await discordKeys();
    const other = await discordKeys();
    const sig = await keys.sign(timestamp, body);
    expect(await verifyDiscord(keys.publicKeyHex, sig, timestamp, body.replace('cardsearch', 'cardsearcx'))).toBe(false);
    expect(await verifyDiscord(keys.publicKeyHex, sig, '1794675829', body)).toBe(false);
    expect(await verifyDiscord(other.publicKeyHex, sig, timestamp, body)).toBe(false);
    expect(await verifyDiscord(keys.publicKeyHex, sig.slice(2), timestamp, body)).toBe(false);
    expect(await verifyDiscord(keys.publicKeyHex, 'zz'.repeat(64), timestamp, body)).toBe(false);
    expect(await verifyDiscord(keys.publicKeyHex, null, timestamp, body)).toBe(false);
    expect(await verifyDiscord('not-hex', sig, timestamp, body)).toBe(false);
  });
});

describe('Telegram secret token', () => {
  it('compares the header to the secret', () => {
    expect(verifyTelegram('s3cret_-A', 's3cret_-A')).toBe(true);
    expect(verifyTelegram('s3cret_-A', 's3cret_-B')).toBe(false);
    expect(verifyTelegram('s3cret_-A', 's3cret_-A2')).toBe(false);
    expect(verifyTelegram('s3cret_-A', undefined)).toBe(false);
    expect(verifyTelegram('s3cret_-A', '')).toBe(false);
  });

  it('timingSafeEqual handles different lengths and multi-byte text', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('\u00e9', 'e')).toBe(false);
  });
});
