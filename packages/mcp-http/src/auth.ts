/**
 * Bearer authentication for /mcp: a static token from VID2CONTEXT_MCP_TOKENS
 * (compared by SHA-256 in constant time) or an OAuth access token issued by
 * this server for this resource. A 401 carries `WWW-Authenticate` with
 * `resource_metadata`, which is how ChatGPT and Claude discover the
 * authorization server.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { Vid2ContextError } from '@vid2context/core';
import type { McpHttpConfig } from './config.ts';
import { sha256, sha256Hex, timingSafeEqual } from './crypto.ts';
import { errorResponse } from './errors.ts';
import type { OAuthStore } from './store.ts';
import { SCOPE, sameResource, type Urls } from './urls.ts';

export interface Principal {
  /** Stable id for rate limits and session binding; never the token itself. */
  id: string;
  kind: 'static' | 'oauth';
  authInfo: AuthInfo;
}

export function oauthEnabled(cfg: McpHttpConfig): boolean {
  return cfg.ownerPasswordHash !== undefined;
}

export function authConfigured(cfg: McpHttpConfig): boolean {
  return cfg.tokenHashes.length > 0 || oauthEnabled(cfg);
}

function challenge(cfg: McpHttpConfig, urls: Urls, error?: { code: string; description: string }): string {
  const parts = ['Bearer realm="vid2context"'];
  if (error) parts.push(`error="${error.code}"`, `error_description="${error.description.replace(/"/g, "'")}"`);
  if (oauthEnabled(cfg)) parts.push(`resource_metadata="${urls.resourceMetadata}"`, `scope="${SCOPE}"`);
  return parts.join(', ');
}

function unauthorized(cfg: McpHttpConfig, urls: Urls, message: string, hint: string, invalidToken: boolean): Response {
  return errorResponse(new Vid2ContextError('auth', message, { hint }), 401, {
    'www-authenticate': challenge(cfg, urls, invalidToken ? { code: 'invalid_token', description: message } : undefined),
  });
}

const HOW_TO = 'Send "Authorization: Bearer <token>" with a token from VID2CONTEXT_MCP_TOKENS, or connect through OAuth.';

export async function authenticate(
  req: Request,
  cfg: McpHttpConfig,
  store: OAuthStore,
  urls: Urls,
): Promise<{ ok: true; principal: Principal } | { ok: false; response: Response }> {
  if (!authConfigured(cfg)) {
    return {
      ok: false,
      response: unauthorized(
        cfg,
        urls,
        'This MCP server has no credentials configured, so it refuses every request.',
        'Set VID2CONTEXT_MCP_TOKENS (static bearer tokens) or VID2CONTEXT_OWNER_PASSWORD_HASH (OAuth for connectors) and restart.',
        false,
      ),
    };
  }
  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header);
  if (!m) {
    return { ok: false, response: unauthorized(cfg, urls, 'Missing bearer token.', HOW_TO, false) };
  }
  const token = m[1] as string;

  if (cfg.tokenHashes.length > 0) {
    const presented = await sha256(token);
    let match = false;
    // Compare against every configured hash, without stopping at the first match.
    for (const h of cfg.tokenHashes) match = timingSafeEqual(presented, h) || match;
    if (match) {
      const id = `static:${(await sha256Hex(token)).slice(0, 16)}`;
      return { ok: true, principal: { id, kind: 'static', authInfo: { token, clientId: id, scopes: [SCOPE] } } };
    }
  }

  if (oauthEnabled(cfg)) {
    const rec = await store.verifyAccess(token);
    if (rec && sameResource(rec.resource, urls.resource)) {
      return {
        ok: true,
        principal: {
          id: `oauth:${rec.familyId}`,
          kind: 'oauth',
          authInfo: {
            token,
            clientId: rec.clientId,
            scopes: rec.scope.split(' ').filter(Boolean),
            expiresAt: Math.floor(rec.expiresAt / 1000),
            resource: new URL(rec.resource),
          },
        },
      };
    }
  }
  return {
    ok: false,
    response: unauthorized(
      cfg,
      urls,
      'The bearer token is invalid, expired or was issued for another server.',
      'Reconnect the connector to get a new token, or check the token against VID2CONTEXT_MCP_TOKENS.',
      true,
    ),
  };
}
