/**
 * A small single-owner OAuth 2.1 authorization server for MCP connectors:
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server        RFC 8414
 *   POST /oauth/register                                RFC 7591 dynamic client registration
 *   GET  /oauth/authorize, POST /oauth/authorize        code flow, PKCE S256 only, owner password + consent
 *   POST /oauth/token                                   authorization_code and refresh_token (rotating)
 *   POST /oauth/revoke                                  RFC 7009
 *
 * Clients can also skip registration with a Client ID Metadata Document
 * (client_id is an https URL), which ChatGPT and Claude prefer.
 */
import type { Ctx, KvStore } from '@vid2context/core';
import type { Context, Hono } from 'hono';
import { oauthEnabled } from './auth.ts';
import { findClient, redirectMatches, registerClient } from './clients.ts';
import type { McpHttpConfig } from './config.ts';
import { randomToken, sha256Hex, timingSafeEqualString, verifyPkceS256 } from './crypto.ts';
import { json, oauthError, rateLimited } from './errors.ts';
import { corsHeaders, PUBLIC_CORS, withHeaders } from './guard.ts';
import { consentPage, messagePage, type PageResult } from './page.ts';
import { takeToken } from './ratelimit.ts';
import { verifyPassword } from './scrypt.ts';
import type { ClientRecord, IssuedTokens, OAuthStore } from './store.ts';
import { SCOPE, sameResource, type Urls } from './urls.ts';

export interface RequestState {
  cfg: McpHttpConfig;
  store: OAuthStore;
  kv: KvStore;
  ctx: Ctx;
  urls: Urls;
  /** Best-effort client address for login and registration limits. */
  ip: string;
}

export type GetState = (c: Context) => Promise<RequestState>;

/** Failed password attempts allowed per address per 15 minutes, and in total per hour. */
const FAILS_PER_IP = 5;
const FAILS_GLOBAL = 30;
const CSRF_COOKIE = 'v2c_oauth_csrf';

function page(p: PageResult, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(p.html, { status, headers: { ...p.headers, ...extra } });
}

function notConfigured(): Response {
  return oauthError(
    'temporarily_unavailable',
    'OAuth is off on this server: set VID2CONTEXT_OWNER_PASSWORD_HASH (see docs/guides/remote-mcp.md), or use a static bearer token.',
    404,
  );
}

export function authorizationServerMetadata(urls: Urls): Record<string, unknown> {
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    registration_endpoint: urls.register,
    revocation_endpoint: urls.revoke,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://github.com/nirholas/vid2context/blob/main/docs/guides/remote-mcp.md',
  };
}

export function protectedResourceMetadata(urls: Urls): Record<string, unknown> {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'vid2context',
    resource_documentation: 'https://github.com/nirholas/vid2context/blob/main/docs/guides/remote-mcp.md',
  };
}

/** Redirect back to the client with an error or a code, always carrying `state` and `iss` (RFC 9207). */
function redirectBack(redirectUri: string, params: Record<string, string | undefined>, issuer: string): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set('iss', issuer);
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
}

function cookie(value: string, secure: boolean, maxAge: number): string {
  return `${CSRF_COOKIE}=${value}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

async function formOrJson(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  const out: Record<string, string> = {};
  if (type.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body ?? {})) if (typeof v === 'string') out[k] = v;
    return out;
  }
  const params = new URLSearchParams(await req.text());
  for (const [k, v] of params) out[k] = v;
  return out;
}

function tokenResponse(t: IssuedTokens): Response {
  return json(
    {
      access_token: t.accessToken,
      token_type: 'Bearer',
      expires_in: t.expiresIn,
      refresh_token: t.refreshToken,
      scope: t.scope,
    },
    200,
    { 'cache-control': 'no-store', pragma: 'no-cache' },
  );
}

/** Client authentication at the token and revocation endpoints (Basic header or form fields). */
async function authenticateClient(
  req: Request,
  form: Record<string, string>,
  s: RequestState,
): Promise<{ ok: true; client: ClientRecord } | { ok: false; response: Response }> {
  let clientId = form.client_id;
  let secret = form.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (basic) {
    try {
      const [id, sec] = atob(basic[1] as string).split(':');
      clientId = decodeURIComponent(id ?? '');
      secret = decodeURIComponent(sec ?? '');
    } catch {
      return { ok: false, response: oauthError('invalid_client', 'Malformed Basic authorization header.', 401) };
    }
  }
  if (!clientId) return { ok: false, response: oauthError('invalid_client', 'client_id is required.', 401) };
  const found = await findClient(clientId, s.cfg, s.store, s.ctx);
  if (!found.ok) return { ok: false, response: oauthError('invalid_client', `Client rejected: ${found.reason}.`, 401) };
  const client = found.client;
  if (client.tokenEndpointAuthMethod !== 'none') {
    const ok =
      Boolean(secret) &&
      client.secretHash !== undefined &&
      timingSafeEqualString(await sha256Hex(secret as string), client.secretHash);
    if (!ok) return { ok: false, response: oauthError('invalid_client', 'Client authentication failed.', 401) };
  }
  return { ok: true, client };
}

export function mountOAuth(app: Hono, getState: GetState): void {
  const prm = async (c: Context) => {
    const s = await getState(c);
    if (!oauthEnabled(s.cfg)) return withHeaders(notConfigured(), PUBLIC_CORS);
    return json(protectedResourceMetadata(s.urls), 200, { ...PUBLIC_CORS, 'cache-control': 'public, max-age=3600' });
  };
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-protected-resource/mcp', prm);

  app.get('/.well-known/oauth-authorization-server', async (c) => {
    const s = await getState(c);
    if (!oauthEnabled(s.cfg)) return withHeaders(notConfigured(), PUBLIC_CORS);
    return json(authorizationServerMetadata(s.urls), 200, { ...PUBLIC_CORS, 'cache-control': 'public, max-age=3600' });
  });

  // ---------------------------------------------------------------- registration

  app.post('/oauth/register', async (c) => {
    const s = await getState(c);
    const cors = corsHeaders(c.req.raw, s.cfg);
    if (!oauthEnabled(s.cfg)) return withHeaders(notConfigured(), cors);
    for (const [key, cap] of [
      [`oauth-register:${s.ip}`, 10],
      ['oauth-register:*', 100],
    ] as const) {
      const d = await takeToken(s.kv, key, cap, 3600);
      if (!d.ok) return withHeaders(rateLimited(d.retryAfterSec, 'client registrations'), cors);
    }
    const body = await c.req.json().catch(() => null);
    const result = await registerClient(body, s.cfg, s.store);
    return json(result.body, result.status, { ...cors, 'cache-control': 'no-store' });
  });

  // ---------------------------------------------------------------- authorization

  app.get('/oauth/authorize', async (c) => {
    const s = await getState(c);
    if (!oauthEnabled(s.cfg)) {
      return page(messagePage('OAuth is off', 'The owner has not set VID2CONTEXT_OWNER_PASSWORD_HASH on this server.'), 404);
    }
    const q = c.req.query();
    const found = await findClient(q.client_id ?? '', s.cfg, s.store, s.ctx);
    if (!found.ok) return page(messagePage('Unknown client', `This app could not be verified: ${found.reason}.`), 400);
    const client = found.client;
    const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !redirectMatches(redirectUri, client.redirectUris)) {
      return page(messagePage('Invalid redirect', 'The redirect_uri does not match one registered for this app.'), 400);
    }
    // From here on, errors go back to the client's redirect URI.
    const back = (error: string, description: string) =>
      redirectBack(redirectUri, { error, error_description: description, state: q.state }, s.urls.issuer);
    if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return back('invalid_request', 'PKCE is required with code_challenge_method=S256.');
    }
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(q.code_challenge)) return back('invalid_request', 'Malformed code_challenge.');
    const scopes = (q.scope ?? SCOPE).split(' ').filter(Boolean);
    if (scopes.some((sc) => sc !== SCOPE)) return back('invalid_scope', `The only scope is "${SCOPE}".`);
    if (q.resource && !sameResource(q.resource, s.urls.resource)) {
      return back('invalid_target', `This server issues tokens only for ${s.urls.resource}.`);
    }
    const csrf = randomToken(24);
    const requestId = await s.store.putRequest({
      clientId: client.clientId,
      clientName: client.clientName ?? client.clientId,
      redirectUri,
      codeChallenge: q.code_challenge,
      state: q.state,
      scope: SCOPE,
      resource: s.urls.resource,
      csrfHash: await sha256Hex(csrf),
    });
    const p = consentPage({
      requestId,
      csrf,
      clientName: client.clientName ?? 'An app',
      clientId: client.clientId,
      redirectUri,
      scope: SCOPE,
    });
    return page(p, 200, { 'set-cookie': cookie(csrf, s.urls.origin.startsWith('https:'), 600) });
  });

  app.post('/oauth/authorize', async (c) => {
    const s = await getState(c);
    const req = c.req.raw;
    if (!oauthEnabled(s.cfg)) return page(messagePage('OAuth is off', 'VID2CONTEXT_OWNER_PASSWORD_HASH is not set.'), 404);
    const origin = req.headers.get('origin');
    if (origin && origin !== 'null' && origin !== s.urls.origin && origin !== new URL(req.url).origin) {
      return page(messagePage('Refused', 'This form must be submitted from this server.'), 403);
    }
    const form = await formOrJson(req);
    const requestId = form.request_id ?? '';
    const ar = requestId ? await s.store.getRequest(requestId) : null;
    if (!ar) return page(messagePage('Sign-in expired', 'Start again from the app you were connecting.'), 400);
    const csrf = form.csrf ?? '';
    const csrfOk =
      csrf.length > 0 &&
      timingSafeEqualString(await sha256Hex(csrf), ar.csrfHash) &&
      timingSafeEqualString(readCookie(req, CSRF_COOKIE) ?? '', csrf);
    if (!csrfOk) return page(messagePage('Refused', 'The form token did not match. Start again from the app.'), 403);

    if (form.decision !== 'approve') {
      await s.store.deleteRequest(requestId);
      return redirectBack(
        ar.redirectUri,
        { error: 'access_denied', error_description: 'The owner denied access.', state: ar.state },
        s.urls.issuer,
      );
    }
    const [ipFails, allFails] = await Promise.all([s.store.failures(`ip:${s.ip}`), s.store.failures('all')]);
    if (ipFails >= FAILS_PER_IP || allFails >= FAILS_GLOBAL) {
      return page(
        messagePage('Too many attempts', 'Sign-in is paused after repeated wrong passwords. Wait 15 minutes and retry.'),
        429,
        {
          'retry-after': '900',
        },
      );
    }
    const ok = await verifyPassword(form.password ?? '', s.cfg.ownerPasswordHash as string);
    if (!ok) {
      await s.store.addFailure(`ip:${s.ip}`, 900);
      await s.store.addFailure('all', 3600);
      s.ctx.log.warn('mcp-http: wrong owner password on the OAuth sign-in page', { ip: s.ip });
      const again = consentPage({
        requestId,
        csrf,
        clientName: ar.clientName,
        clientId: ar.clientId,
        redirectUri: ar.redirectUri,
        scope: ar.scope,
        error: 'Wrong password.',
      });
      return page(again, 401);
    }
    await s.store.deleteRequest(requestId);
    const code = await s.store.issueCode({
      clientId: ar.clientId,
      redirectUri: ar.redirectUri,
      codeChallenge: ar.codeChallenge,
      scope: ar.scope,
      resource: ar.resource,
    });
    const res = redirectBack(ar.redirectUri, { code, state: ar.state }, s.urls.issuer);
    res.headers.set('set-cookie', cookie('', s.urls.origin.startsWith('https:'), 0));
    return res;
  });

  // ---------------------------------------------------------------- token

  app.post('/oauth/token', async (c) => {
    const s = await getState(c);
    const req = c.req.raw;
    const cors = corsHeaders(req, s.cfg);
    if (!oauthEnabled(s.cfg)) return withHeaders(notConfigured(), cors);
    const form = await formOrJson(req);
    const authed = await authenticateClient(req, form, s);
    if (!authed.ok) return withHeaders(authed.response, cors);
    const client = authed.client;

    if (form.grant_type === 'authorization_code') {
      if (!form.code || !form.code_verifier) {
        return withHeaders(oauthError('invalid_request', 'code and code_verifier are required.'), cors);
      }
      const rec = await s.store.takeCode(form.code);
      if (!rec || rec.clientId !== client.clientId) {
        return withHeaders(oauthError('invalid_grant', 'The code is invalid, expired or already used.'), cors);
      }
      if (form.redirect_uri !== undefined && form.redirect_uri !== rec.redirectUri) {
        return withHeaders(oauthError('invalid_grant', 'redirect_uri does not match the authorization request.'), cors);
      }
      if (!(await verifyPkceS256(form.code_verifier, rec.codeChallenge))) {
        return withHeaders(oauthError('invalid_grant', 'PKCE verification failed.'), cors);
      }
      if (form.resource && !sameResource(form.resource, rec.resource)) {
        return withHeaders(oauthError('invalid_target', 'resource does not match the authorization request.'), cors);
      }
      const tokens = await s.store.issueTokens(client.clientId, rec.scope, rec.resource);
      if (client.kind === 'dcr') await s.store.putClient(client);
      return withHeaders(tokenResponse(tokens), cors);
    }

    if (form.grant_type === 'refresh_token') {
      if (!form.refresh_token) return withHeaders(oauthError('invalid_request', 'refresh_token is required.'), cors);
      const rotated = await s.store.rotateRefresh(form.refresh_token, client.clientId);
      if (!rotated.ok) {
        const why =
          rotated.reason === 'reused'
            ? 'The refresh token was already used; every token from this sign-in is now revoked. Sign in again.'
            : 'The refresh token is invalid or expired.';
        return withHeaders(oauthError('invalid_grant', why), cors);
      }
      const rec = rotated.record;
      if (form.resource && !sameResource(form.resource, rec.resource)) {
        return withHeaders(oauthError('invalid_target', 'resource does not match the original grant.'), cors);
      }
      if (form.scope?.split(' ').some((sc) => !rec.scope.split(' ').includes(sc))) {
        return withHeaders(oauthError('invalid_scope', 'A refresh cannot add scopes.'), cors);
      }
      const tokens = await s.store.issueTokens(client.clientId, rec.scope, rec.resource, rec.familyId);
      if (client.kind === 'dcr') await s.store.putClient(client);
      return withHeaders(tokenResponse(tokens), cors);
    }

    return withHeaders(oauthError('unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token.'), cors);
  });

  // ---------------------------------------------------------------- revocation

  app.post('/oauth/revoke', async (c) => {
    const s = await getState(c);
    const req = c.req.raw;
    const cors = corsHeaders(req, s.cfg);
    if (!oauthEnabled(s.cfg)) return withHeaders(notConfigured(), cors);
    const form = await formOrJson(req);
    const authed = await authenticateClient(req, form, s);
    if (!authed.ok) return withHeaders(authed.response, cors);
    if (form.token) await s.store.revoke(form.token, authed.client.clientId);
    // RFC 7009: answer 200 whether or not the token existed.
    return new Response(null, { status: 200, headers: { ...cors, 'cache-control': 'no-store' } });
  });
}
