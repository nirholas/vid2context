/**
 * Node entry: `npm run start:server` (or `dev:server` with reload).
 * Listens on PORT (default 8787) and HOST (default 127.0.0.1, so it is not
 * exposed to the network unless you ask for it with HOST=0.0.0.0).
 *
 * Opens the library storage once and shares it between the HTTP app and the
 * in-process jobs queue. On SIGTERM or SIGINT it stops accepting connections,
 * lets in-flight requests finish (up to VID2CONTEXT_SHUTDOWN_TIMEOUT_MS,
 * default 10000), closes MCP sessions, the jobs queue and the download queue
 * (deleting its temporary files), then exits.
 */
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { MemoryStorage } from '@vid2context/core';
import { createDownloader, createDownloadManager } from '@vid2context/downloads/node';
import { createJobQueue, registerBuiltinKinds } from '@vid2context/jobs';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';
import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app.ts';
import { nodeHealthChecks } from './health-node.ts';

loadEnvFiles();
const registry = createRegistry();
const baseCtx = createNodeContext();
const storage = (await registry.openStorage(baseCtx)) ?? new MemoryStorage();
const queue = createJobQueue({ registry, ctx: baseCtx, storage });
registerBuiltinKinds(queue);
const downloads = createDownloadManager({ downloader: createDownloader({ registry }) });

const port = Number(process.env.PORT) || 8787;
const hostname = process.env.HOST || '127.0.0.1';
const loopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');

const app = createApp({
  registry,
  makeCtx: (req) => createNodeContext({ signal: req.signal }),
  version: pkg.version,
  storage: async () => storage,
  jobs: { queue },
  downloads,
  clientIp: (c) => {
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined;
    }
  },
  mcpDnsRebindingProtection: loopback,
  healthChecks: nodeHealthChecks,
});

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.error(`[vid2context] HTTP API listening on http://${hostname}:${info.port}/api/v1/health`);
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  const graceMs = Number(process.env.VID2CONTEXT_SHUTDOWN_TIMEOUT_MS) || 10_000;
  console.error(`[vid2context] ${signal}: no longer accepting connections, finishing in-flight requests (up to ${graceMs} ms)`);
  const force = setTimeout(() => {
    console.error('[vid2context] in-flight requests did not finish in time; exiting');
    process.exit(1);
  }, graceMs);
  force.unref();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // Keep-alive sockets with no request in progress would otherwise hold close() open.
  if ('closeIdleConnections' in server) server.closeIdleConnections();
  await closed;
  await Promise.allSettled([app.close(), queue.close(), downloads.close()]);
  clearTimeout(force);
  console.error('[vid2context] stopped');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
