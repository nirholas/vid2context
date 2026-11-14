/**
 * Resource subscriptions. A client subscribes to a resource URI and gets
 * `notifications/resources/updated` when it changes; it then re-reads it.
 *
 * Subscriptions are tracked per server instance. The SDK binds one transport
 * to one server, so a stdio server is one session and a Streamable HTTP
 * deployment creates one server per session: per server is per session.
 * Closed servers are dropped the next time a notification is sent.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const URI_SCHEME = 'vid2context:';

const subscriptions = new WeakMap<McpServer, Set<string>>();
/** Servers that currently hold at least one subscription, for process-wide broadcasts. */
const subscribed = new Set<McpServer>();

/** `vid2context://collection/{id}/latest` for a collection id. */
export function collectionLatestUri(collectionId: string): string {
  return `vid2context://collection/${encodeURIComponent(collectionId)}/latest`;
}

/** `vid2context://collection/{id}` (the collection resource served by the base MCP tools). */
export function collectionUri(collectionId: string): string {
  return `vid2context://collection/${encodeURIComponent(collectionId)}`;
}

function validUri(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Not a valid URI: ${uri}`);
  }
  if (parsed.protocol !== URI_SCHEME) {
    throw new McpError(ErrorCode.InvalidParams, `This server only serves ${URI_SCHEME}// resources, not ${uri}`);
  }
  return uri;
}

/**
 * Declare `resources.subscribe` and handle resources/subscribe and
 * resources/unsubscribe on this server. Must run before `connect`.
 */
export function enableSubscriptions(server: McpServer): void {
  const s = server.server;
  s.assertCanSetRequestHandler('resources/subscribe');
  s.assertCanSetRequestHandler('resources/unsubscribe');
  s.registerCapabilities({ resources: { subscribe: true } });
  s.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = validUri(req.params.uri);
    let set = subscriptions.get(server);
    if (!set) {
      set = new Set();
      subscriptions.set(server, set);
    }
    set.add(uri);
    subscribed.add(server);
    return {};
  });
  s.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    const set = subscriptions.get(server);
    set?.delete(req.params.uri);
    if (set && set.size === 0) subscribed.delete(server);
    return {};
  });
}

/** URIs this server's client is subscribed to. */
export function subscribedUris(server: McpServer): string[] {
  return [...(subscriptions.get(server) ?? [])];
}

function forget(server: McpServer): void {
  subscriptions.delete(server);
  subscribed.delete(server);
}

/** Send `notifications/resources/updated` for `uri` when this server's client subscribed to it. Returns true when sent. */
export async function notifyResourceUpdated(server: McpServer, uri: string): Promise<boolean> {
  if (!subscriptions.get(server)?.has(uri)) return false;
  if (!server.isConnected()) {
    forget(server);
    return false;
  }
  await server.server.sendResourceUpdated({ uri });
  return true;
}

/**
 * Tell subscribers that a collection changed (for example, it gained a video).
 * Sends `notifications/resources/updated` for `vid2context://collection/{id}/latest`
 * and `vid2context://collection/{id}` to every client subscribed to either.
 *
 * `notifyCollectionUpdated(server, id)` notifies that server's client only.
 * `notifyCollectionUpdated(id)` notifies every subscribed session in this
 * process, which is what library ingest calls when it does not hold a server.
 * Returns the number of notifications sent.
 */
export async function notifyCollectionUpdated(server: McpServer, collectionId: string): Promise<number>;
export async function notifyCollectionUpdated(collectionId: string): Promise<number>;
export async function notifyCollectionUpdated(a: McpServer | string, b?: string): Promise<number> {
  const id = typeof a === 'string' ? a : (b ?? '');
  const servers = typeof a === 'string' ? [...subscribed] : [a];
  const uris = [collectionLatestUri(id), collectionUri(id)];
  let sent = 0;
  for (const server of servers) {
    for (const uri of uris) {
      try {
        if (await notifyResourceUpdated(server, uri)) sent++;
      } catch {
        // The transport closed between the check and the send: drop this session.
        forget(server);
      }
    }
  }
  return sent;
}
