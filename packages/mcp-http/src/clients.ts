/**
 * OAuth clients: redirect URI rules, RFC 7591 dynamic registration, and
 * Client ID Metadata Documents (the MCP spec's preferred registration, used
 * by ChatGPT and Claude), where the client_id is an https URL serving the
 * client's metadata as JSON.
 */
import { type Ctx, safeFetch } from '@vid2context/core';
import type { McpHttpConfig } from './config.ts';
import { randomToken, sha256Hex } from './crypto.ts';
import type { ClientRecord, OAuthStore, TokenEndpointAuthMethod } from './store.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackHttp(u: URL): boolean {
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
}

/** A redirect URI may be https, or http on a loopback host (native apps and development). No fragments, no credentials. */
export function redirectUriProblem(uri: string, cfg: McpHttpConfig): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return `"${uri}" is not an absolute URL`;
  }
  if (u.hash) return `"${uri}" must not contain a fragment`;
  if (u.username || u.password) return `"${uri}" must not contain credentials`;
  if (u.protocol !== 'https:' && !isLoopbackHttp(u)) return `"${uri}" must use https (or http on localhost)`;
  if (cfg.allowedRedirects.length > 0 && !cfg.allowedRedirects.some((p) => uri.startsWith(p))) {
    return `"${uri}" is not in VID2CONTEXT_OAUTH_ALLOWED_REDIRECTS`;
  }
  return null;
}

/**
 * Exact string match against a registered URI, except that a loopback
 * redirect may use any port (RFC 8252 section 7.3): native clients pick a
 * free port at run time.
 */
export function redirectMatches(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(r)) return false;
  return registered.some((reg) => {
    try {
      const g = new URL(reg);
      return isLoopbackHttp(g) && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search;
    } catch {
      return false;
    }
  });
}

const AUTH_METHODS: TokenEndpointAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];

export interface RegistrationResult {
  status: number;
  body: Record<string, unknown>;
}

/** RFC 7591 registration. Returns the response body for a 201, or an OAuth error body for a 400. */
export async function registerClient(input: unknown, cfg: McpHttpConfig, store: OAuthStore): Promise<RegistrationResult> {
  const bad = (error: string, description: string): RegistrationResult => ({
    status: 400,
    body: { error, error_description: description },
  });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return bad('invalid_client_metadata', 'The body must be a JSON object.');
  }
  const m = input as Record<string, unknown>;
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string')) {
    return bad('invalid_redirect_uri', 'redirect_uris must be an array of 1 to 10 URLs.');
  }
  for (const u of uris as string[]) {
    const problem = redirectUriProblem(u, cfg);
    if (problem) return bad('invalid_redirect_uri', problem);
  }
  // RFC 7591: the default is client_secret_basic. MCP clients normally send "none".
  const method = (m.token_endpoint_auth_method ?? 'client_secret_basic') as TokenEndpointAuthMethod;
  if (!AUTH_METHODS.includes(method)) {
    return bad('invalid_client_metadata', `token_endpoint_auth_method must be one of: ${AUTH_METHODS.join(', ')}.`);
  }
  const grantTypes = (m.grant_types ?? ['authorization_code']) as unknown;
  if (!Array.isArray(grantTypes) || !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
    return bad('invalid_client_metadata', 'grant_types may contain only authorization_code and refresh_token.');
  }
  const responseTypes = (m.response_types ?? ['code']) as unknown;
  if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === 'code')) {
    return bad('invalid_client_metadata', 'response_types may contain only code.');
  }
  const name = typeof m.client_name === 'string' ? m.client_name.slice(0, 200) : undefined;
  const clientUri = typeof m.client_uri === 'string' && /^https:\/\//.test(m.client_uri) ? m.client_uri : undefined;

  const clientId = randomToken(18);
  const secret = method === 'none' ? undefined : randomToken(32);
  const record: ClientRecord = {
    clientId,
    clientName: name,
    clientUri,
    redirectUris: uris as string[],
    tokenEndpointAuthMethod: method,
    secretHash: secret ? await sha256Hex(secret) : undefined,
    kind: 'dcr',
    createdAt: Date.now(),
  };
  await store.putClient(record);
  return {
    status: 201,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(record.createdAt / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      redirect_uris: record.redirectUris,
      token_endpoint_auth_method: method,
      grant_types: grantTypes,
      response_types: responseTypes,
      ...(name ? { client_name: name } : {}),
      ...(clientUri ? { client_uri: clientUri } : {}),
    },
  };
}

/** A client_id that names a metadata document: an https URL with a path. */
export function isMetadataDocumentId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === 'https:' && u.pathname.length > 1 && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

const CIMD_MAX_BYTES = 16 * 1024;

export type ResolveResult = { ok: true; client: ClientRecord } | { ok: false; reason: string };

/**
 * Fetch and validate a Client ID Metadata Document, caching it in the store
 * for its Cache-Control max-age (5 minutes to 1 day). The fetch goes through
 * the core SSRF guard, so a client_id cannot point the server at its own network.
 */
export async function resolveMetadataClient(
  clientId: string,
  cfg: McpHttpConfig,
  store: OAuthStore,
  ctx: Ctx,
): Promise<ResolveResult> {
  const cached = await store.getClient(clientId);
  if (cached?.kind === 'cimd') return { ok: true, client: cached };
  let doc: Record<string, unknown>;
  let maxAge = 3600;
  try {
    const res = await safeFetch(ctx, clientId, {
      maxBytes: CIMD_MAX_BYTES,
      maxRedirects: 0,
      timeoutMs: 5000,
      accept: ['application/json'],
      headers: { accept: 'application/json' },
    });
    if (res.status !== 200) return { ok: false, reason: `the client metadata document answered HTTP ${res.status}` };
    doc = JSON.parse(new TextDecoder().decode(res.bytes)) as Record<string, unknown>;
    const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
    if (m) maxAge = Number(m[1]);
  } catch (err) {
    return { ok: false, reason: `the client metadata document could not be fetched (${(err as Error).message})` };
  }
  if (!doc || typeof doc !== 'object' || doc.client_id !== clientId) {
    return { ok: false, reason: 'the document client_id does not match the URL exactly' };
  }
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string')) {
    return { ok: false, reason: 'the document has no redirect_uris' };
  }
  for (const u of uris as string[]) {
    const problem = redirectUriProblem(u, cfg);
    if (problem) return { ok: false, reason: problem };
  }
  // This server takes public clients only from documents: "none" must be the declared or a supported method.
  const supported = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [];
  const declared = doc.token_endpoint_auth_method ?? 'none';
  if (declared !== 'none' && !supported.includes('none')) {
    return { ok: false, reason: `token_endpoint_auth_method "${String(declared)}" is not supported; use "none"` };
  }
  const client: ClientRecord = {
    clientId,
    clientName: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 200) : undefined,
    clientUri: typeof doc.client_uri === 'string' ? doc.client_uri : undefined,
    redirectUris: uris as string[],
    tokenEndpointAuthMethod: 'none',
    kind: 'cimd',
    createdAt: Date.now(),
  };
  await store.putClient(client, Math.min(86_400, Math.max(300, maxAge)));
  return { ok: true, client };
}

/** Look up a registered client, or resolve a metadata document client. */
export async function findClient(clientId: string, cfg: McpHttpConfig, store: OAuthStore, ctx: Ctx): Promise<ResolveResult> {
  if (!clientId || clientId.length > 2048) return { ok: false, reason: 'missing or oversized client_id' };
  if (isMetadataDocumentId(clientId)) return resolveMetadataClient(clientId, cfg, store, ctx);
  const c = await store.getClient(clientId);
  return c ? { ok: true, client: c } : { ok: false, reason: 'unknown client_id; register the client first' };
}
