/**
 * Request guards: the Host check against DNS rebinding, the Origin check the
 * MCP Streamable HTTP spec requires, and CORS headers for configured origins.
 */
import { Vid2ContextError } from '@vid2context/core';
import type { McpHttpConfig } from './config.ts';
import { errorResponse } from './errors.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostname(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? h;
}

/**
 * DNS-rebinding protection for a server bound to a loopback address: a page on
 * evil.example whose DNS flips to 127.0.0.1 still sends `Host: evil.example`,
 * so only loopback names, the public URL's host and VID2CONTEXT_MCP_ALLOWED_HOSTS pass.
 */
export function checkHost(req: Request, cfg: McpHttpConfig): Response | null {
  const raw = req.headers.get('host') ?? new URL(req.url).host;
  const host = raw.toLowerCase();
  const name = hostname(host);
  const allowed =
    LOOPBACK_HOSTS.has(name) ||
    (cfg.publicOrigin !== undefined && new URL(cfg.publicOrigin).host === host) ||
    (cfg.publicOrigin !== undefined && new URL(cfg.publicOrigin).hostname === name) ||
    cfg.allowedHosts.includes(host) ||
    cfg.allowedHosts.includes(name);
  if (allowed) return null;
  return errorResponse(
    new Vid2ContextError('bad-request', `Host "${raw}" is not allowed.`, {
      hint: 'Set VID2CONTEXT_MCP_PUBLIC_URL to the public URL, or add the host to VID2CONTEXT_MCP_ALLOWED_HOSTS.',
    }),
    403,
  );
}

/** Origins a browser page may call from. The public origin always counts. */
export function originAllowed(origin: string, cfg: McpHttpConfig): boolean {
  return origin === cfg.publicOrigin || cfg.corsOrigins.includes(origin);
}

/** MCP spec: an `Origin` header that is present and not allowed gets 403. Server-to-server clients send none. */
export function checkOrigin(req: Request, cfg: McpHttpConfig): Response | null {
  const origin = req.headers.get('origin');
  if (!origin || originAllowed(origin, cfg)) return null;
  return errorResponse(
    new Vid2ContextError('bad-request', `Origin "${origin}" is not allowed.`, {
      hint: 'Browser clients must be listed in VID2CONTEXT_CORS_ORIGINS. Connectors that call from a server send no Origin.',
    }),
    403,
  );
}

const MCP_REQUEST_HEADERS =
  'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id, mcp-method, mcp-name';
const MCP_EXPOSE_HEADERS = 'mcp-session-id, mcp-protocol-version, www-authenticate, retry-after';

/** CORS headers for a configured origin, or none. */
export function corsHeaders(req: Request, cfg: McpHttpConfig): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin || !originAllowed(origin, cfg)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': MCP_REQUEST_HEADERS,
    'access-control-expose-headers': MCP_EXPOSE_HEADERS,
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/** Public, credential-free documents (metadata, server card) may be read from any page. */
export const PUBLIC_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': MCP_REQUEST_HEADERS,
};

export function withHeaders(res: Response, headers: Record<string, string>): Response {
  if (Object.keys(headers).length === 0) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
