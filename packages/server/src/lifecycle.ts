/**
 * Node process lifecycle for the HTTP server: socket timeouts against slow
 * clients, a shutdown that cannot hang on long-lived streams, and a guard
 * that logs unhandled promise rejections instead of letting one stray
 * rejection end every in-flight request.
 */
import type { Server } from 'node:http';
import type { Env } from '@vid2context/core';

function int(raw: string | undefined, fallback: number): number {
  const v = raw?.trim();
  const n = Number(v);
  return v && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface SocketTimeouts {
  /** Longest a client may take to send the request headers. */
  headersTimeoutMs: number;
  /** How long an idle keep-alive socket stays open. */
  keepAliveTimeoutMs: number;
  /** Longest a client may take to send the whole request (body included); 0 = no limit. */
  requestTimeoutMs: number;
}

export function socketTimeouts(env: Env): SocketTimeouts {
  return {
    headersTimeoutMs: int(env.VID2CONTEXT_HEADERS_TIMEOUT_MS, 30_000),
    keepAliveTimeoutMs: int(env.VID2CONTEXT_KEEPALIVE_TIMEOUT_MS, 5_000),
    requestTimeoutMs: int(env.VID2CONTEXT_BODY_TIMEOUT_MS, 300_000),
  };
}

/** Apply the socket timeouts to a Node http server. */
export function tuneServer(server: Server, env: Env): SocketTimeouts {
  const t = socketTimeouts(env);
  // Node requires headersTimeout <= requestTimeout when both are set.
  server.requestTimeout = t.requestTimeoutMs;
  server.headersTimeout = t.requestTimeoutMs > 0 ? Math.min(t.headersTimeoutMs, t.requestTimeoutMs) : t.headersTimeoutMs;
  server.keepAliveTimeout = t.keepAliveTimeoutMs;
  return t;
}

export interface CloseOptions {
  /** Total time allowed. */
  graceMs: number;
  /** Closes MCP sessions, the jobs queue, downloads; started once in-flight requests had their share of the grace. */
  cleanup: () => Promise<unknown>;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/**
 * Stop accepting connections, give in-flight requests half the grace period,
 * run cleanup, then cut whatever is still open (SSE job streams, MCP GET
 * streams, requests stuck on a hung upstream) so `close()` can finish.
 * Resolves 'clean' when everything ended by itself, 'forced' when
 * connections had to be cut.
 */
export async function gracefulClose(server: Server, opts: CloseOptions): Promise<'clean' | 'forced'> {
  const log = opts.log ?? (() => undefined);
  const started = Date.now();
  let closed = false;
  const done = new Promise<void>((resolve) =>
    server.close(() => {
      closed = true;
      resolve();
    }),
  );
  // Keep-alive sockets with no request in progress would otherwise hold close() open.
  server.closeIdleConnections();
  await Promise.race([done, sleep(Math.floor(opts.graceMs / 2))]);
  const cleanup = opts
    .cleanup()
    .catch((err: unknown) => log(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`));
  await Promise.race([cleanup, sleep(Math.max(0, opts.graceMs - (Date.now() - started) - 250))]);
  if (closed) return 'clean';
  server.closeIdleConnections();
  await Promise.race([done, sleep(50)]);
  if (closed) return 'clean';
  log('cutting connections that are still open (event streams, stuck requests)');
  server.closeAllConnections();
  await Promise.race([done, sleep(1000)]);
  return 'forced';
}

/**
 * Log unhandled rejections with their stack instead of exiting (Node's
 * default since 15). VID2CONTEXT_EXIT_ON_UNHANDLED=1 restores the exit.
 */
export function installRejectionGuard(env: Env, log: (msg: string) => void): () => void {
  if (['1', 'true', 'yes'].includes(env.VID2CONTEXT_EXIT_ON_UNHANDLED ?? '')) return () => undefined;
  const onRejection = (reason: unknown) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log(`unhandled promise rejection (kept running; VID2CONTEXT_EXIT_ON_UNHANDLED=1 exits instead): ${detail}`);
  };
  process.on('unhandledRejection', onRejection);
  return () => process.off('unhandledRejection', onRejection);
}
