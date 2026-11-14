/**
 * Streamable HTTP for the tools of `createServer()` from @vid2context/mcp.
 *
 * stateless  A new McpServer and transport per request, no Mcp-Session-Id.
 *            Works on Workers and serverless, where no memory survives
 *            between requests. GET and DELETE answer 405.
 * session    One McpServer per Mcp-Session-Id, kept in memory on Node and
 *            closed after VID2CONTEXT_MCP_SESSION_IDLE_SEC without requests.
 *            A session is bound to the credential that opened it.
 *
 * Each request gets its own Ctx from makeCtx(req). In stateless mode the
 * request's abort signal closes the server, which aborts running tool calls.
 * In session mode tool calls get the SDK's per-call signal (cancelled by the
 * client's notifications/cancelled or when the session closes).
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Ctx, Registry, Storage } from '@vid2context/core';
import { createServer, type ServerOptions } from '@vid2context/mcp';
import type { McpHttpMode } from './config.ts';

export interface TransportDeps {
  registry: Registry;
  version: string;
  /** Passed to every createServer() call (for example extractAudio for watch_live). */
  serverOptions?: Omit<ServerOptions, 'storage'>;
}

interface HandleOptions {
  mode: McpHttpMode;
  ctx: Ctx;
  /** One library backend shared by every request and session, so stateless requests do not each open their own. */
  storage: Storage;
  authInfo: AuthInfo;
  principal: string;
  idleSec: number;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  principal: string;
  lastSeen: number;
}

/** Most sessions kept at once; the least recently used one is closed past this. */
const MAX_SESSIONS = 256;

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * JSON or SSE, as the client asks: both are valid for a POST, and clients
 * must accept both, so SSE is used when the Accept header lists
 * text/event-stream before application/json, and JSON otherwise.
 */
export function prefersJson(req: Request): boolean {
  const accept = (req.headers.get('accept') ?? '').toLowerCase();
  const sse = accept.indexOf('text/event-stream');
  const json = accept.indexOf('application/json');
  if (json === -1) return false;
  return sse === -1 || json < sse;
}

export class McpTransport {
  private sessions = new Map<string, Session>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: TransportDeps) {}

  /** Live session count, for health output and tests. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  private build(ctx: Ctx, storage: Storage): McpServer {
    return createServer(this.deps.registry, ctx, this.deps.version, { ...this.deps.serverOptions, storage });
  }

  async handle(req: Request, opts: HandleOptions): Promise<Response> {
    return opts.mode === 'stateless' ? this.stateless(req, opts) : this.session(req, opts);
  }

  private async stateless(req: Request, opts: HandleOptions): Promise<Response> {
    if (req.method !== 'POST') {
      return jsonRpcError(405, -32000, 'Method not allowed: this server is stateless, so only POST is served.', {
        allow: 'POST',
      });
    }
    const server = this.build(opts.ctx, opts.storage);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: prefersJson(req),
    });
    await server.connect(transport);
    const close = () => {
      void server.close();
    };
    if (req.signal.aborted) close();
    else req.signal.addEventListener('abort', close, { once: true });
    const res = await transport.handleRequest(req, { authInfo: opts.authInfo });
    // A JSON response is complete here; an SSE body closes the transport itself when its last response is written.
    if (res.headers.get('content-type')?.includes('application/json') || !res.body) {
      req.signal.removeEventListener('abort', close);
      close();
    }
    return res;
  }

  private async session(req: Request, opts: HandleOptions): Promise<Response> {
    this.sweep(opts.idleSec);
    const sid = req.headers.get('mcp-session-id');
    if (sid) {
      const s = this.sessions.get(sid);
      // A session opened with another credential looks like no session at all.
      if (!s || s.principal !== opts.principal) {
        return jsonRpcError(404, -32001, 'Session not found. Start a new session with an initialize request.');
      }
      s.lastSeen = Date.now();
      return s.transport.handleRequest(req, { authInfo: opts.authInfo });
    }
    if (req.method !== 'POST') {
      return jsonRpcError(400, -32000, 'Bad request: Mcp-Session-Id header is required.');
    }

    // The session outlives this request, so its base Ctx must not carry this request's signal.
    const server = this.build({ ...opts.ctx, signal: undefined }, opts.storage);
    const entry: Partial<Session> = { server, principal: opts.principal, lastSeen: Date.now() };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: prefersJson(req),
      onsessioninitialized: (id) => {
        entry.transport = transport;
        this.sessions.set(id, entry as Session);
        this.evictOverflow();
        this.startSweeper(opts.idleSec);
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    const res = await transport.handleRequest(req, { authInfo: opts.authInfo });
    if (!transport.sessionId) void server.close();
    return res;
  }

  private sweep(idleSec: number): void {
    const cutoff = Date.now() - idleSec * 1000;
    for (const [id, s] of this.sessions) {
      if (s.lastSeen < cutoff) this.closeSession(id, s);
    }
  }

  private evictOverflow(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      let oldest: [string, Session] | undefined;
      for (const e of this.sessions) if (!oldest || e[1].lastSeen < oldest[1].lastSeen) oldest = e;
      if (!oldest) return;
      this.closeSession(oldest[0], oldest[1]);
    }
  }

  private closeSession(id: string, s: Session): void {
    this.sessions.delete(id);
    void s.transport.close().catch(() => undefined);
    void s.server.close().catch(() => undefined);
  }

  private startSweeper(idleSec: number): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(idleSec), Math.min(60_000, idleSec * 500));
    // Never keep a Node process alive just to expire sessions.
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  /** Close every session and stop the sweeper (for shutdown and tests). */
  async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const [id, s] of [...this.sessions]) this.closeSession(id, s);
  }
}
