import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
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
  ZOO,
} from './helpers.ts';

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function oauthServer(extra: Record<string, string> = {}) {
  running = await start({ VID2CONTEXT_OWNER_PASSWORD_HASH: await testPasswordHash(), ...extra }, { mode: 'stateless' });
  return running;
}

async function pkce() {
  const verifier = randomToken(48);
  return { verifier, challenge: base64url(await sha256(verifier)) };
}

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function register(r: Running, body: Record<string, unknown> = {}) {
  const res = await fetch(`${r.origin}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test connector',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      ...body,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

function authorizeUrl(r: Running, params: Record<string, string>): string {
  const u = new URL(`${r.origin}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function token(r: Running, params: Record<string, string>) {
  const res = await fetch(`${r.origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, string | number> };
}

/** Register, authorize as the owner and return the code plus what is needed to redeem it. */
async function signIn(r: Running) {
  const { body: client } = await register(r);
  const { verifier, challenge } = await pkce();
  const page = await fetch(
    authorizeUrl(r, {
      response_type: 'code',
      client_id: client.client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-123',
      scope: 'mcp',
      resource: r.url,
    }),
  );
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(page.headers.get('content-security-policy')).toContain('form-action');
  const form = await readConsent(page);
  expect(form.html).toContain('Test connector');
  const done = await submitConsent(r.origin, form, TEST_PASSWORD);
  expect(done.status).toBe(302);
  const loc = new URL(done.headers.get('location') as string);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('state-123');
  expect(loc.searchParams.get('iss')).toBe(r.origin);
  return { clientId: client.client_id as string, code: loc.searchParams.get('code') as string, verifier };
}

describe('OAuth discovery', () => {
  it('points a 401 at protected resource metadata, which points at the authorization server', async () => {
    const r = await oauthServer();
    const res = await fetch(r.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] as string;
    expect(prmUrl).toBe(`${r.origin}/.well-known/oauth-protected-resource/mcp`);
    expect(challenge).toContain('scope="mcp"');
    const prm = (await (await fetch(prmUrl)).json()) as { resource: string; authorization_servers: string[] };
    expect(prm.resource).toBe(r.url);
    const as = (await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(as).toMatchObject({
      issuer: r.origin,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(as.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('answers 404 with a hint when OAuth is not configured', async () => {
    running = await start({ VID2CONTEXT_MCP_TOKENS: 'x-token-1234567890' });
    const res = await fetch(`${running.origin}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error_description: string }).error_description).toContain('VID2CONTEXT_OWNER_PASSWORD_HASH');
  });
});

describe('OAuth flow over real HTTP', () => {
  it('registers, signs in, exchanges the code, calls a tool, rotates the refresh token and detects reuse', async () => {
    const r = await oauthServer();
    const { clientId, code, verifier } = await signIn(r);

    const t1 = await token(r, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: r.url,
    });
    expect(t1.status).toBe(200);
    expect(t1.headers.get('cache-control')).toBe('no-store');
    expect(t1.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });

    // The code works once.
    const again = await token(r, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    expect(again.body.error).toBe('invalid_grant');

    const { client } = await connectClient(r.url, { authorization: `Bearer ${t1.body.access_token}` });
    const meta = await client.callTool({ name: 'get_metadata', arguments: { url: ZOO } });
    expect(JSON.parse(textOf(meta)).title).toBe('Me at the zoo');
    await client.close();

    const t2 = await token(r, {
      grant_type: 'refresh_token',
      refresh_token: t1.body.refresh_token as string,
      client_id: clientId,
    });
    expect(t2.status).toBe(200);
    expect(t2.body.refresh_token).not.toBe(t1.body.refresh_token);
    const { client: c2 } = await connectClient(r.url, { authorization: `Bearer ${t2.body.access_token}` });
    expect((await c2.listTools()).tools.length).toBeGreaterThan(1);
    await c2.close();

    // The rotated-out refresh token is refused, and its reuse revokes every token from this sign-in.
    const reuse = await token(r, {
      grant_type: 'refresh_token',
      refresh_token: t1.body.refresh_token as string,
      client_id: clientId,
    });
    expect(reuse.body.error).toBe('invalid_grant');
    const after = await fetch(r.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t2.body.access_token}` },
      body: '{}',
    });
    expect(after.status).toBe(401);
    const t3 = await token(r, {
      grant_type: 'refresh_token',
      refresh_token: t2.body.refresh_token as string,
      client_id: clientId,
    });
    expect(t3.body.error).toBe('invalid_grant');
  });

  it('refuses PKCE plain and a missing challenge', async () => {
    const r = await oauthServer();
    const { body: client } = await register(r);
    const cases: Record<string, string>[] = [{ code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' }, {}];
    for (const extra of cases) {
      const res = await fetch(
        authorizeUrl(r, {
          response_type: 'code',
          client_id: client.client_id as string,
          redirect_uri: REDIRECT,
          state: 's',
          ...extra,
        }),
        { redirect: 'manual' },
      );
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location') as string);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('state')).toBe('s');
    }
  });

  it('fails the exchange with a wrong code_verifier', async () => {
    const r = await oauthServer();
    const { clientId, code } = await signIn(r);
    const res = await token(r, { grant_type: 'authorization_code', code, code_verifier: randomToken(48), client_id: clientId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refuses a token for another resource and an unregistered redirect', async () => {
    const r = await oauthServer();
    const { body: client } = await register(r);
    const { challenge } = await pkce();
    const base = {
      response_type: 'code',
      client_id: client.client_id as string,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const other = await fetch(authorizeUrl(r, { ...base, redirect_uri: REDIRECT, resource: 'https://elsewhere.example/mcp' }), {
      redirect: 'manual',
    });
    expect(new URL(other.headers.get('location') as string).searchParams.get('error')).toBe('invalid_target');
    const badRedirect = await fetch(authorizeUrl(r, { ...base, redirect_uri: 'https://evil.example/cb' }), {
      redirect: 'manual',
    });
    // Never redirect to an unregistered URI: show an error page instead.
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.headers.get('location')).toBeNull();
  });

  it('rejects registrations with unsafe redirect URIs', async () => {
    const r = await oauthServer();
    expect((await register(r, { redirect_uris: ['http://example.com/cb'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register(r, { redirect_uris: ['https://x.example/cb#frag'] })).body.error).toBe('invalid_redirect_uri');
    const confidential = await register(r, { token_endpoint_auth_method: undefined });
    expect(confidential.status).toBe(201);
    // RFC 7591 default is client_secret_basic, so a secret is issued.
    expect(confidential.body.client_secret).toBeTruthy();
  });

  it('authenticates confidential clients with client_secret_basic', async () => {
    const r = await oauthServer();
    const { body: client } = await register(r, { token_endpoint_auth_method: 'client_secret_basic' });
    const { verifier, challenge } = await pkce();
    const page = await fetch(
      authorizeUrl(r, {
        response_type: 'code',
        client_id: client.client_id as string,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    );
    const done = await submitConsent(r.origin, await readConsent(page), TEST_PASSWORD);
    const code = new URL(done.headers.get('location') as string).searchParams.get('code') as string;
    const send = (secret: string) =>
      fetch(`${r.origin}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${btoa(`${client.client_id}:${secret}`)}`,
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }).toString(),
      });
    expect((await send('wrong-secret')).status).toBe(401);
    const ok = await send(client.client_secret as string);
    expect(ok.status).toBe(200);
  });
});

describe('owner sign-in page', () => {
  it('rejects a wrong password, pauses after repeated failures and honours Deny', async () => {
    const r = await oauthServer();
    const { body: client } = await register(r);
    const { challenge } = await pkce();
    const open = () =>
      fetch(
        authorizeUrl(r, {
          response_type: 'code',
          client_id: client.client_id as string,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'st',
        }),
      ).then(readConsent);

    const denied = await submitConsent(r.origin, await open(), '', 'deny');
    expect(new URL(denied.headers.get('location') as string).searchParams.get('error')).toBe('access_denied');

    const form = await open();
    const forged = await submitConsent(r.origin, { ...form, cookie: 'v2c_oauth_csrf=forged' }, TEST_PASSWORD);
    expect(forged.status).toBe(403);
    const crossSite = await fetch(`${r.origin}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: form.cookie, origin: 'https://evil.example' },
      body: new URLSearchParams({ request_id: form.requestId, csrf: form.csrf, password: TEST_PASSWORD, decision: 'approve' }),
    });
    expect(crossSite.status).toBe(403);

    for (let i = 0; i < 5; i++) {
      const wrong = await submitConsent(r.origin, form, 'not the password');
      expect(wrong.status).toBe(401);
      expect(await wrong.text()).toContain('Wrong password.');
    }
    const paused = await submitConsent(r.origin, form, TEST_PASSWORD);
    expect(paused.status).toBe(429);
    expect(paused.headers.get('retry-after')).toBe('900');
  });
});

describe('Client ID Metadata Documents', () => {
  it('accepts Claude, ChatGPT and Claude Code documents without registration', async () => {
    const r = await oauthServer();
    const { challenge } = await pkce();
    const cases = [
      ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.ai/api/mcp/auth_callback', 'Claude'],
      ['https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect', 'ChatGPT'],
      // Claude Code registers http://localhost/callback and picks a port at run time (RFC 8252).
      ['https://claude.ai/oauth/claude-code-client-metadata', 'http://localhost:53682/callback', 'Claude Code'],
    ] as const;
    for (const [clientId, redirect, name] of cases) {
      const res = await fetch(
        authorizeUrl(r, {
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirect,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: r.url,
        }),
      );
      expect(res.status, clientId).toBe(200);
      expect(await res.text()).toContain(`<strong>${name}</strong>`);
    }
    // Each document was fetched once from its client_id URL.
    expect(r.calls.filter((c) => c.url.startsWith('https://claude.ai/oauth/')).length).toBe(2);
  });

  it('completes the flow for a CIMD client and refuses a redirect the document does not list', async () => {
    const r = await oauthServer();
    const clientId = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    const { verifier, challenge } = await pkce();
    const base = { response_type: 'code', client_id: clientId, code_challenge: challenge, code_challenge_method: 'S256' };
    const bad = await fetch(authorizeUrl(r, { ...base, redirect_uri: 'https://claude.ai/elsewhere' }), { redirect: 'manual' });
    expect(bad.status).toBe(400);
    const page = await fetch(authorizeUrl(r, { ...base, redirect_uri: REDIRECT }));
    const done = await submitConsent(r.origin, await readConsent(page), TEST_PASSWORD);
    const code = new URL(done.headers.get('location') as string).searchParams.get('code') as string;
    const t = await token(r, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      resource: r.url,
    });
    expect(t.status).toBe(200);
    expect(t.body.access_token).toBeTruthy();
  });
});

/** An OAuthClientProvider whose "browser" is fetch: it submits the owner form and captures the code. */
class TestProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  code?: string;
  constructor(
    private readonly origin: string,
    readonly clientMetadataUrl?: string,
  ) {}
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return { client_name: 'SDK test client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  async redirectToAuthorization(url: URL) {
    const page = await fetch(url);
    const done = await submitConsent(this.origin, await readConsent(page), TEST_PASSWORD);
    this.code = new URL(done.headers.get('location') as string).searchParams.get('code') ?? undefined;
  }
}

async function sdkFlow(r: Running, provider: TestProvider) {
  const first = new StreamableHTTPClientTransport(new URL(r.url), { authProvider: provider });
  const client = new Client({ name: 'sdk-oauth', version: '0.0.0' });
  await expect(client.connect(first)).rejects.toThrow(/Unauthorized/i);
  expect(provider.code).toBeTruthy();
  await first.finishAuth(provider.code as string);
  const second = new StreamableHTTPClientTransport(new URL(r.url), { authProvider: provider });
  const c2 = new Client({ name: 'sdk-oauth', version: '0.0.0' });
  await c2.connect(second);
  return c2;
}

describe("the SDK's own OAuth client", () => {
  it('discovers, registers dynamically, signs in and calls a tool', async () => {
    const r = await oauthServer();
    const provider = new TestProvider(r.origin);
    const client = await sdkFlow(r, provider);
    expect(provider.info?.client_id).toBeTruthy();
    const meta = await client.callTool({ name: 'get_metadata', arguments: { url: ZOO } });
    expect(JSON.parse(textOf(meta)).channel.name).toBe('jawed');
    await client.close();
  });

  it('uses a Client ID Metadata Document when the client has one', async () => {
    const r = await oauthServer();
    const provider = new TestProvider(r.origin, 'https://claude.ai/oauth/mcp-oauth-client-metadata');
    const client = await sdkFlow(r, provider);
    expect(provider.info?.client_id).toBe('https://claude.ai/oauth/mcp-oauth-client-metadata');
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('get_transcript');
    await client.close();
  });
});
