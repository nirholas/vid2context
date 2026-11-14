/**
 * LIVE=1: the full OAuth flow and a tool call against real YouTube, through
 * the real node context (real fetch). Run with `npm run test:live`.
 */
import { MemoryKv, MemoryStorage } from '@vid2context/core';
import { createNodeContext } from '@vid2context/registry/node';
import { afterEach, describe, expect, it } from 'vitest';
import { base64url, randomToken, sha256 } from '../src/crypto.ts';
import {
  connectClient,
  type Running,
  readConsent,
  start,
  submitConsent,
  TEST_PASSWORD,
  testPasswordHash,
  textOf,
} from './helpers.ts';

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe.skipIf(!process.env.LIVE)('live: OAuth then get_metadata against YouTube', () => {
  it('signs in, gets a token and reads real metadata', async () => {
    const env = { VID2CONTEXT_OWNER_PASSWORD_HASH: await testPasswordHash() };
    running = await start(env, {
      ctx: (req) => createNodeContext({ env, signal: req.signal }),
      storage: async () => new MemoryStorage(),
      kv: new MemoryKv(),
    });
    const r = running;
    const redirect = 'http://127.0.0.1:9/callback';
    const reg = (await (
      await fetch(`${r.origin}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
      })
    ).json()) as { client_id: string };
    const verifier = randomToken(48);
    const u = new URL(`${r.origin}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: redirect,
      code_challenge: base64url(await sha256(verifier)),
      code_challenge_method: 'S256',
      resource: r.url,
    })) {
      u.searchParams.set(k, v);
    }
    const done = await submitConsent(r.origin, await readConsent(await fetch(u)), TEST_PASSWORD);
    const code = new URL(done.headers.get('location') as string).searchParams.get('code') as string;
    const tok = (await (
      await fetch(`${r.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id }),
      })
    ).json()) as { access_token: string };
    const { client } = await connectClient(r.url, { authorization: `Bearer ${tok.access_token}` });
    const meta = await client.callTool({
      name: 'get_metadata',
      arguments: { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
    });
    expect(JSON.parse(textOf(meta))).toMatchObject({ title: 'Me at the zoo' });
    await client.close();
  }, 60_000);
});
