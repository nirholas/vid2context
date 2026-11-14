/**
 * A small MCP Apps view client: the View side of the MCP Apps protocol
 * (specification 2026-01-26, the version @modelcontextprotocol/ext-apps
 * implements), spoken as JSON-RPC 2.0 over postMessage with the host.
 *
 * Why not the ext-apps `App` class: it validates every message with zod v4,
 * which bundles all of zod and its locales into the page (about 580 KB of
 * the viewer's HTML, plus library strings such as JSON Schema dialect URLs).
 * This client sends and handles the same messages the `App` class does, with
 * the same method names and payloads (typed from ext-apps), and
 * test/bridge.test.ts checks it against the ext-apps `AppBridge`, the SDK's
 * own host implementation.
 *
 * Messages used:
 *   View -> Host requests       ui/initialize, ui/open-link, ui/message, ui/request-display-mode
 *   View -> Host notifications  ui/notifications/initialized, ui/notifications/size-changed
 *   Host -> View notifications  ui/notifications/tool-input, tool-result, tool-cancelled, host-context-changed
 *   Host -> View requests       ping, ui/resource-teardown
 */
import type {
  McpUiAppCapabilities,
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiInitializeResult,
  McpUiToolResultNotification,
} from '@modelcontextprotocol/ext-apps';

/** The MCP Apps protocol version this client speaks (ext-apps LATEST_PROTOCOL_VERSION). */
export const PROTOCOL_VERSION = '2026-01-26';

type Id = number | string;
interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** Where messages go and where they come from: `window.parent` and `window` in a real iframe. */
export interface BridgeChannel {
  post(message: JsonRpcMessage): void;
  listen(handler: (message: unknown) => void): () => void;
}

export interface BridgeHandlers {
  onToolInput?(args: Record<string, unknown> | undefined): void;
  onToolResult?(result: McpUiToolResultNotification['params']): void;
  onToolCancelled?(reason: string | undefined): void;
  onHostContextChanged?(context: McpUiHostContext): void;
  onTeardown?(): void | Promise<void>;
}

export interface BridgeOptions {
  appInfo: { name: string; version: string };
  appCapabilities?: McpUiAppCapabilities;
  handlers?: BridgeHandlers;
  /** Request timeout in ms. Default 60 s, the MCP SDK default. */
  timeoutMs?: number;
}

/** The channel for a view running in an iframe: post to the parent with origin "*", accept messages only from the parent. */
export function windowChannel(win: Window): BridgeChannel {
  const parent = win.parent;
  return {
    post: (message) => parent.postMessage(message, '*'),
    listen: (handler) => {
      const fn = (ev: MessageEvent) => {
        if (ev.source === parent) handler(ev.data);
      };
      win.addEventListener('message', fn);
      return () => win.removeEventListener('message', fn);
    },
  };
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export class ViewBridge {
  private nextId = 1;
  private readonly pending = new Map<Id, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private stopListening: (() => void) | undefined;
  private initialized = false;
  hostCapabilities: McpUiHostCapabilities | undefined;
  hostContext: McpUiHostContext = {};
  hostInfo: { name: string; version: string } | undefined;

  constructor(
    private readonly channel: BridgeChannel,
    private readonly options: BridgeOptions,
  ) {}

  /** Run the ui/initialize handshake. Register handlers before calling this so no early notification is missed. */
  async connect(): Promise<McpUiInitializeResult> {
    this.stopListening = this.channel.listen((m) => this.receive(m));
    try {
      const result = (await this.request('ui/initialize', {
        appCapabilities: this.options.appCapabilities ?? {},
        appInfo: this.options.appInfo,
        protocolVersion: PROTOCOL_VERSION,
      })) as unknown as McpUiInitializeResult;
      this.hostCapabilities = result.hostCapabilities ?? {};
      this.hostContext = result.hostContext ?? {};
      this.hostInfo = result.hostInfo;
      this.notify('ui/notifications/initialized', {});
      this.initialized = true;
      return result;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  get connected(): boolean {
    return this.initialized;
  }

  close(): void {
    this.stopListening?.();
    this.stopListening = undefined;
    this.initialized = false;
    for (const p of this.pending.values()) p.reject(new BridgeError('connection closed', -32000));
    this.pending.clear();
  }

  /** ui/open-link. Resolves true when the host opened the URL. */
  async openLink(url: string): Promise<boolean> {
    const r = await this.request('ui/open-link', { url });
    return r.isError !== true;
  }

  /** ui/message with one text block, role "user". Resolves true when the host accepted it. */
  async sendMessage(text: string): Promise<boolean> {
    const r = await this.request('ui/message', { role: 'user', content: [{ type: 'text', text }] });
    return r.isError !== true;
  }

  /** ui/request-display-mode. Resolves with the mode the host actually set. */
  async requestDisplayMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode> {
    const r = await this.request('ui/request-display-mode', { mode });
    const actual = typeof r.mode === 'string' ? (r.mode as McpUiDisplayMode) : (this.hostContext.displayMode ?? 'inline');
    this.hostContext = { ...this.hostContext, displayMode: actual };
    return actual;
  }

  sendSizeChanged(size: { width?: number; height?: number }): void {
    this.notify('ui/notifications/size-changed', size);
  }

  /**
   * Report the document size to the host whenever it changes, as the ext-apps
   * App does with autoResize: measure <html> at max-content height on the
   * next frame, send only when width or height changed.
   */
  autoResize(win: Window): () => void {
    const doc = win.document;
    let queued = false;
    let lastW = 0;
    let lastH = 0;
    const check = () => {
      if (queued) return;
      queued = true;
      win.requestAnimationFrame(() => {
        queued = false;
        const html = doc.documentElement;
        const prev = html.style.height;
        html.style.height = 'max-content';
        const height = Math.ceil(html.getBoundingClientRect().height);
        html.style.height = prev;
        const width = Math.ceil(win.innerWidth);
        if (width !== lastW || height !== lastH) {
          lastW = width;
          lastH = height;
          this.sendSizeChanged({ width, height });
        }
      });
    };
    check();
    if (typeof win.ResizeObserver !== 'function') return () => {};
    const ro = new win.ResizeObserver(check);
    ro.observe(doc.documentElement);
    ro.observe(doc.body);
    return () => ro.disconnect();
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`${method} timed out after ${timeoutMs} ms`, -32001));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.channel.post({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.channel.post({ jsonrpc: '2.0', method, params });
  }

  private respond(id: Id, result: Record<string, unknown>): void {
    this.channel.post({ jsonrpc: '2.0', id, result });
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || (raw as JsonRpcMessage).jsonrpc !== '2.0') return;
    const m = raw as JsonRpcMessage;
    // A response to one of our requests.
    if (m.method === undefined && m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new BridgeError(m.error.message, m.error.code));
      else p.resolve(m.result ?? {});
      return;
    }
    if (typeof m.method !== 'string') return;
    const params = (m.params ?? {}) as Record<string, unknown>;
    const h = this.options.handlers ?? {};
    // A request from the host.
    if (m.id !== undefined) {
      const id = m.id;
      if (m.method === 'ping') return this.respond(id, {});
      if (m.method === 'ui/resource-teardown') {
        void Promise.resolve(h.onTeardown?.()).finally(() => this.respond(id, {}));
        return;
      }
      this.channel.post({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      return;
    }
    // A notification from the host.
    switch (m.method) {
      case 'ui/notifications/tool-input':
        h.onToolInput?.(params.arguments as Record<string, unknown> | undefined);
        break;
      case 'ui/notifications/tool-result':
        h.onToolResult?.(params as McpUiToolResultNotification['params']);
        break;
      case 'ui/notifications/tool-cancelled':
        h.onToolCancelled?.(typeof params.reason === 'string' ? params.reason : undefined);
        break;
      case 'ui/notifications/host-context-changed':
        this.hostContext = { ...this.hostContext, ...(params as McpUiHostContext) };
        h.onHostContextChanged?.(this.hostContext);
        break;
      default:
        break;
    }
  }
}
