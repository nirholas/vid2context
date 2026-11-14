/**
 * Public URLs of this server. VID2CONTEXT_MCP_PUBLIC_URL wins over the request
 * URL, because behind a tunnel or proxy the request arrives as plain http on
 * a local port while clients know the server as https://<public host>.
 */
import type { McpHttpConfig } from './config.ts';

export const MCP_PATH = '/mcp';
export const SCOPE = 'mcp';

export interface Urls {
  origin: string;
  /** The OAuth issuer: the origin, no path, no trailing slash. */
  issuer: string;
  /** The protected resource: what tokens are bound to and what users paste into a connector. */
  resource: string;
  /** RFC 9728 metadata, path-inserted for the /mcp resource. */
  resourceMetadata: string;
  authorize: string;
  token: string;
  register: string;
  revoke: string;
  serverCard: string;
}

export function urlsFor(req: Request, cfg: McpHttpConfig): Urls {
  const origin = cfg.publicOrigin ?? new URL(req.url).origin;
  return {
    origin,
    issuer: origin,
    resource: `${origin}${MCP_PATH}`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`,
    authorize: `${origin}/oauth/authorize`,
    token: `${origin}/oauth/token`,
    register: `${origin}/oauth/register`,
    revoke: `${origin}/oauth/revoke`,
    serverCard: `${origin}${MCP_PATH}/server-card`,
  };
}

/** RFC 8707 resource comparison: same URL, ignoring a trailing slash and the case of scheme and host. */
export function sameResource(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/+$/, '') || '/';
    return x.origin === y.origin && path(x) === path(y) && x.search === y.search && !x.hash && !y.hash;
  } catch {
    return false;
  }
}
