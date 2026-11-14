/**
 * Discovery for the remote server, checked 2026-11-14:
 *
 * - MCP Server Card (SEP-2127, marked Final on modelcontextprotocol.io; the
 *   modelcontextprotocol/ext-server-card README still says experimental):
 *   GET <streamable-http-url>/server-card, media type
 *   application/mcp-server-card+json, CORS open to every origin. Built from
 *   serverJson() in @vid2context/discovery so name, version and description
 *   match the MCP Registry entry.
 * - AI Catalog (ai-catalog.io working draft): /.well-known/ai-catalog.json,
 *   media type application/ai-catalog+json, one entry pointing at the card.
 * - OpenAI app directory domain verification: /.well-known/openai-apps-challenge
 *   returns the token from VID2CONTEXT_OPENAI_APPS_CHALLENGE as plain text.
 */
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { serverJson } from '@vid2context/discovery';
import { sha256Hex } from './crypto.ts';
import type { Urls } from './urls.ts';

export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
export const SERVER_CARD_TYPE = 'application/mcp-server-card+json';

export function serverCard(urls: Urls): Record<string, unknown> {
  const s = serverJson();
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: s.name,
    title: s.title,
    version: s.version,
    description: s.description.slice(0, 100),
    websiteUrl: s.websiteUrl,
    repository: s.repository,
    icons: s.icons,
    remotes: [{ type: 'streamable-http', url: urls.resource, supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] }],
  };
}

export function aiCatalog(urls: Urls): Record<string, unknown> {
  const host = new URL(urls.origin).hostname;
  return {
    specVersion: '1.0',
    entries: [{ identifier: `urn:air:${host}:mcp:vid2context`, type: SERVER_CARD_TYPE, url: urls.serverCard }],
  };
}

/** A JSON document response with an ETag, honouring If-None-Match. */
export async function cachedJson(req: Request, body: unknown, contentType: string): Promise<Response> {
  const text = JSON.stringify(body, null, 2);
  const etag = `"${(await sha256Hex(text)).slice(0, 32)}"`;
  const headers = {
    'content-type': contentType,
    'cache-control': 'public, max-age=3600',
    etag,
    'access-control-allow-origin': '*',
  };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(text, { status: 200, headers });
}
