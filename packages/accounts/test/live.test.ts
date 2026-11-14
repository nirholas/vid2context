/**
 * Live checks against the real services, gated by LIVE=1. They repeat the
 * calls recorded in test/fixtures (see README.md there).
 */
import { readFileSync } from 'node:fs';
import { createContext, MemoryKv } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { beginGithubLogin, exchangeGithubCode, fetchGithubIdentity } from '../src/github.ts';
import { verifyTurnstile } from '../src/turnstile.ts';

const live = () => createContext({ runtime: 'node', env: {} });
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`fixtures/${f}`, import.meta.url), 'utf8'));
const DUMMY = 'XXXX.DUMMY.TOKEN.XXXX';

describe.skipIf(!process.env.LIVE)('Cloudflare Turnstile siteverify (live, public test keys)', () => {
  it('passes with the always-pass secret, as recorded', async () => {
    const res = await verifyTurnstile(live(), {
      secret: '1x0000000000000000000000000000000AA',
      token: DUMMY,
      remoteIp: '203.0.113.7',
    });
    const rec = fixture('turnstile-siteverify-pass.json');
    expect(res).toMatchObject({ success: rec.success, errorCodes: rec['error-codes'], hostname: rec.hostname });
  });

  it('fails with the always-fail and duplicate secrets, as recorded', async () => {
    for (const [secret, file] of [
      ['2x0000000000000000000000000000000AA', 'turnstile-siteverify-fail.json'],
      ['3x0000000000000000000000000000000AA', 'turnstile-siteverify-duplicate.json'],
    ] as const) {
      const res = await verifyTurnstile(live(), { secret, token: DUMMY });
      expect(res).toMatchObject({ success: false, errorCodes: fixture(file)['error-codes'] });
    }
  });
});

describe.skipIf(!process.env.LIVE)('GitHub OAuth endpoints (live, no account needed)', () => {
  it('answers an unknown OAuth app with 404, which we report as a configuration problem', async () => {
    const err = await exchangeGithubCode(live(), {
      clientId: 'Ov23li0000000000000000',
      clientSecret: '0000000000000000000000000000000000000000',
      code: '0000000000',
      redirectUri: 'http://127.0.0.1:8787/api/v1/auth/github/callback',
      verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'upstream', status: 404 });
  });

  it('rejects an invalid token on /user', async () => {
    const err = await fetchGithubIdentity(live(), 'gho_000000000000000000000000000000000000').catch((e) => e);
    expect(err).toMatchObject({ code: 'upstream', status: 401 });
  });

  it('serves the authorize page for the URL we build', async () => {
    const { url } = await beginGithubLogin(new MemoryKv(), {
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID || 'Ov23li0000000000000000',
      redirectUri: 'http://127.0.0.1:8787/api/v1/auth/github/callback',
      returnTo: '/app/',
    });
    const res = await fetch(url, { redirect: 'manual' });
    // Signed out, GitHub sends the browser to its login page and keeps the request for afterwards.
    expect([200, 302]).toContain(res.status);
    await res.body?.cancel();
  });
});

const id = process.env.GITHUB_OAUTH_CLIENT_ID;
const secret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

describe.skipIf(!process.env.LIVE || !id || !secret)(
  'GitHub OAuth app credentials (live, needs GITHUB_OAUTH_CLIENT_ID and _SECRET)',
  () => {
    it('accepts the app credentials and rejects a made-up code as bad_verification_code', async () => {
      const err = await exchangeGithubCode(live(), {
        clientId: id ?? '',
        clientSecret: secret ?? '',
        code: '0000000000',
        redirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI ?? 'http://127.0.0.1:8787/api/v1/auth/github/callback',
        verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      }).catch((e) => e);
      expect(err).toMatchObject({ code: 'bad-request', message: expect.stringContaining('bad_verification_code') });
    });
  },
);
