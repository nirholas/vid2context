/**
 * `serve` (HTTP API from @vid2context/server) and `mcp` (stdio MCP server
 * from @vid2context/mcp). Both run until Ctrl-C (ctx.signal) or, for mcp,
 * until the client closes stdin. Loaded lazily so `get` does not pay for them.
 */
import { positiveInt, str } from '../args.ts';
import { UsageError } from '../exit-codes.ts';
import type { CommandContext } from '../runtime.ts';

function untilAborted(signal: AbortSignal | undefined, also?: (done: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener('abort', () => resolve(), { once: true });
    also?.(resolve);
  });
}

export async function serveCommand(c: CommandContext): Promise<number> {
  const env = c.deps.ctx.env;
  const port = positiveInt(c.values, 'port') ?? (Number(env.PORT) || 8787);
  if (port > 65535) throw new UsageError(`--port must be 65535 or lower, got ${port}.`);
  const hostname = str(c.values, 'host') ?? env.HOST ?? '127.0.0.1';
  const [{ serve }, { createApp }, { createContext }] = await Promise.all([
    import('@hono/node-server'),
    import('@vid2context/server'),
    import('@vid2context/core'),
  ]);
  const base = c.deps.ctx;
  const app = createApp({
    registry: c.deps.registry,
    makeCtx: (req) =>
      createContext({ runtime: base.runtime, env: base.env, fetch: base.fetch, log: base.log, signal: req.signal }),
    version: c.version,
  });
  const listening = new Promise<number>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => resolve(info.port));
    server.once('error', reject);
    c.deps.ctx.signal?.addEventListener('abort', () => server.close(), { once: true });
  });
  const actual = await listening;
  c.deps.io.stderr(`vid2context HTTP API listening on http://${hostname}:${actual}/api/v1/health (Ctrl-C to stop)\n`);
  await untilAborted(c.deps.ctx.signal);
  return 0;
}

export async function mcpCommand(c: CommandContext): Promise<number> {
  const [{ createServer }, { StdioServerTransport }] = await Promise.all([
    import('@vid2context/mcp'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
  ]);
  const server = createServer(c.deps.registry, c.deps.ctx, c.version);
  const transport = new StdioServerTransport();
  const closed = untilAborted(c.deps.ctx.signal, (done) => {
    transport.onclose = done;
    process.stdin.once('end', done);
  });
  await server.connect(transport);
  c.deps.ctx.log.info('vid2context MCP server ready on stdio');
  await closed;
  await server.close();
  return 0;
}
