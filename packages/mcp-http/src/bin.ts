#!/usr/bin/env -S npx tsx
/**
 * vid2context-mcp-http: the remote MCP server on Node.
 *
 *   vid2context-mcp-http [--port 8790] [--host 127.0.0.1]
 *   vid2context-mcp-http hash-password     reads a password from stdin, prints VID2CONTEXT_OWNER_PASSWORD_HASH
 *
 * Loads .env through loadEnvFiles(). Logs go to stderr; the only stdout
 * output is the hash printed by hash-password.
 */
import { lookup } from 'node:dns/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { authConfigured, oauthEnabled } from './auth.ts';
import { readConfig } from './config.ts';
import { hashPassword } from './scrypt.ts';

const USAGE = `Usage:
  vid2context-mcp-http [--port <port>] [--host <host>]
  vid2context-mcp-http hash-password

Options:
  --port   TCP port (default: PORT or 8790)
  --host   Address to bind (default: HOST or 127.0.0.1). Use 0.0.0.0 only behind TLS.
  --help   Show this help.

Env: VID2CONTEXT_MCP_TOKENS, VID2CONTEXT_OWNER_PASSWORD_HASH, VID2CONTEXT_MCP_PUBLIC_URL and more,
see docs/guides/remote-mcp.md.`;

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  // Interactive: prompt on stderr and keep the typed password off the screen.
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void };
  let prompted = false;
  out._writeToOutput = (s: string) => {
    if (!prompted) {
      process.stderr.write(s);
      prompted = true;
    }
  };
  const pw = await new Promise<string>((resolve) => rl.question('Owner password: ', resolve));
  rl.close();
  process.stderr.write('\n');
  return pw;
}

async function hashCommand(): Promise<void> {
  const pw = await readPassword();
  if (pw.length < 12) {
    console.error('[vid2context] error: use a password of at least 12 characters (a long random passphrase is best).');
    process.exit(2);
  }
  process.stdout.write(`${await hashPassword(pw)}\n`);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.error(USAGE);
    return;
  }
  if (positionals[0] === 'hash-password') return hashCommand();
  if (positionals.length > 0) {
    console.error(`[vid2context] error: unknown command "${positionals[0]}"\n\n${USAGE}`);
    process.exit(2);
  }

  // Loaded only to serve, so hash-password works even when a provider package is broken.
  const [
    { serve },
    { setHostResolver },
    { createFfmpegExtractor },
    { createNodeContext, createRegistry, loadEnvFiles },
    { mcpHttpRoutes },
  ] = await Promise.all([
    import('@hono/node-server'),
    import('@vid2context/core'),
    import('@vid2context/live/node'),
    import('@vid2context/registry/node'),
    import('./routes.ts'),
  ]);
  const loaded = loadEnvFiles();
  const port = Number(values.port ?? process.env.PORT ?? 8790);
  const hostname = values.host ?? process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`[vid2context] error: invalid --port "${values.port}"`);
    process.exit(2);
  }

  // Client ID Metadata Documents are fetched from client-supplied URLs: check every resolved address, not just the name.
  setHostResolver((host) => lookup(host, { all: true }).then((a) => a.map((x) => x.address)));
  const ctx = createNodeContext();
  const cfg = await readConfig(ctx.env);
  const app = mcpHttpRoutes({
    registry: createRegistry(),
    makeCtx: (req) => createNodeContext({ signal: req.signal }),
    version: pkg.version,
    serverOptions: { extractAudio: createFfmpegExtractor({ env: ctx.env }) },
    dnsRebindingProtection: LOOPBACK.has(hostname),
  });

  if (loaded.length > 0) ctx.log.info(`loaded env from ${loaded.join(', ')}`);
  if (cfg.ownerPasswordHashInvalid) {
    console.error(
      '[vid2context] error: VID2CONTEXT_OWNER_PASSWORD_HASH is not a scrypt hash. Generate one with: vid2context-mcp-http hash-password',
    );
  }
  if (!authConfigured(cfg)) {
    console.error(
      '[vid2context] warning: no credentials configured, so /mcp refuses every request. Set VID2CONTEXT_MCP_TOKENS or VID2CONTEXT_OWNER_PASSWORD_HASH.',
    );
  }
  if (oauthEnabled(cfg) && !cfg.publicOrigin) {
    console.error(
      '[vid2context] warning: OAuth is on but VID2CONTEXT_MCP_PUBLIC_URL is not set; tokens are bound to the URL each request arrives on. Set it to the https URL connectors use.',
    );
  }

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    const host = hostname.includes(':') ? `[${hostname}]` : hostname;
    const auth = [cfg.tokenHashes.length > 0 ? `${cfg.tokenHashes.length} static token(s)` : '', oauthEnabled(cfg) ? 'OAuth' : '']
      .filter(Boolean)
      .join(' + ');
    console.error(
      `[vid2context] remote MCP on http://${host}:${info.port}/mcp (auth: ${auth || 'none configured'}; mode: ${cfg.mode ?? 'session'})`,
    );
    if (cfg.publicOrigin) console.error(`[vid2context] public URL: ${cfg.publicOrigin}/mcp`);
  });

  const stop = async () => {
    await app.closeSessions();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

await main();
