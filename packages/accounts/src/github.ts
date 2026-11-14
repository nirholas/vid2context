/**
 * GitHub sign-in: the OAuth web application flow with `state` and PKCE (S256).
 * Endpoints and parameters as documented at
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 * (checked 2026-11-14).
 *
 * The scope is always empty: the token can read only public profile data, and
 * vid2context keeps three fields of it (numeric id, login, avatar URL). No
 * email scope is requested and no email is read or stored. The GitHub access
 * token is used once to read /user and is never stored.
 *
 * Keys:
 *   accounts:oauth:<state>   OAuthState (10 minutes, deleted when used)
 */
import { type Ctx, fetchWithTimeout, type KvStore, Vid2ContextError } from '@vid2context/core';
import type { GithubIdentity } from './accounts.ts';
import { randomToken, sha256Base64url } from './crypto.ts';

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';
/** Requested OAuth scope. Empty on purpose: public profile only, never email. */
export const GITHUB_SCOPE = '';
/** GitHub codes expire after 10 minutes; the state record lives as long. */
export const OAUTH_STATE_TTL_SEC = 600;

export interface OAuthState {
  verifier: string;
  redirectUri: string;
  returnTo: string;
  createdAt: string;
}

const stateKey = (state: string) => `accounts:oauth:${state}`;

/** S256 code challenge for a PKCE verifier (RFC 7636). */
export function pkceChallenge(verifier: string): Promise<string> {
  return sha256Base64url(verifier);
}

/** Start a sign-in: store a fresh state and PKCE verifier and return GitHub's authorize URL. */
export async function beginGithubLogin(
  kv: KvStore,
  opts: { clientId: string; redirectUri: string; returnTo: string },
): Promise<{ url: string; state: string }> {
  const state = randomToken(32);
  const verifier = randomToken(32);
  const record: OAuthState = {
    verifier,
    redirectUri: opts.redirectUri,
    returnTo: opts.returnTo,
    createdAt: new Date().toISOString(),
  };
  await kv.kvSet(stateKey(state), record, { ttlSec: OAUTH_STATE_TTL_SEC });
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.href, state };
}

/** Look up and delete a state, so each one works once. Null when unknown or expired. */
export async function consumeOAuthState(kv: KvStore, state: string | undefined): Promise<OAuthState | null> {
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  const record = await kv.kvGet<OAuthState>(stateKey(state));
  if (!record) return null;
  await kv.kvDelete(stateKey(state));
  return record;
}

const RESTART = 'Start sign-in again from /api/v1/auth/github/login.';

/** Exchange the authorization code (with the PKCE verifier) for an access token. */
export async function exchangeGithubCode(
  ctx: Ctx,
  opts: { clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  const res = await fetchWithTimeout(
    ctx,
    GITHUB_TOKEN_URL,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'vid2context' },
      body,
    },
    15_000,
  );
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok) {
    throw new Vid2ContextError('upstream', `GitHub token endpoint answered HTTP ${res.status}${data.error ? ` (${data.error})` : ''}.`, {
      status: res.status,
      hint: 'Check GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET: GitHub answers 404 for an unknown OAuth app.',
    });
  }
  if (data.error || !data.access_token) {
    const code = data.error ?? 'no_access_token';
    if (code === 'incorrect_client_credentials' || code === 'redirect_uri_mismatch') {
      throw new Vid2ContextError('upstream', `GitHub rejected the OAuth app settings: ${code}.`, {
        hint: 'Check GITHUB_OAUTH_CLIENT_SECRET, and that GITHUB_OAUTH_REDIRECT_URI matches the callback URL registered on the OAuth app.',
      });
    }
    throw new Vid2ContextError('bad-request', `GitHub sign-in failed: ${code}.`, { hint: RESTART });
  }
  return data.access_token;
}

/** Read the signed-in user's numeric id, login and avatar URL. Nothing else is kept. */
export async function fetchGithubIdentity(ctx: Ctx, token: string): Promise<GithubIdentity> {
  const res = await fetchWithTimeout(
    ctx,
    GITHUB_USER_URL,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'vid2context',
        'x-github-api-version': '2022-11-28',
      },
    },
    15_000,
  );
  if (!res.ok) {
    throw new Vid2ContextError('upstream', `GitHub /user answered HTTP ${res.status}.`, { status: res.status, hint: RESTART });
  }
  const user = (await res.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || typeof user.login !== 'string' || !user.login) {
    throw new Vid2ContextError('upstream', 'GitHub /user returned no numeric id and login.', { hint: RESTART });
  }
  const avatar = typeof user.avatar_url === 'string' && user.avatar_url.startsWith('https://') ? user.avatar_url : undefined;
  return avatar ? { id: user.id, login: user.login, avatarUrl: avatar } : { id: user.id, login: user.login };
}
