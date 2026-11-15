/**
 * /embed.js: the loader for sites that embed vid2context. It defines the
 * <vid2context-embed> element and window.Vid2Context.embed(), both of which
 * place the /embed/ widget in an iframe served from the same origin as this
 * script, size it to its content, re-dispatch the widget's messages as DOM
 * events and expose seek, search, theme and load commands.
 *
 * Bundled to a small IIFE by src/pages/embed.js.ts; the parameter names and
 * the default heights come from src/lib/embed.ts at build time.
 */

declare const __V2C_PARAMS__: string[];
declare const __V2C_HEIGHTS__: Record<string, number>;

interface WidgetMessage {
  source: string;
  type: string;
  [k: string]: unknown;
}

type LoadTarget = { url: string } | { sample: string } | { src: string };

(() => {
  if (typeof window === 'undefined' || !('customElements' in window)) return;
  if (customElements.get('vid2context-embed')) return;

  const script = document.currentScript as HTMLScriptElement | null;
  const scriptUrl = script?.src ? new URL(script.src) : new URL('https://vid2context.com/embed.js');
  const ORIGIN = scriptUrl.origin;
  // Keep any base path the script is served under (for example /vid2context/embed.js).
  const BASE = `${ORIGIN}${scriptUrl.pathname.replace(/\/embed\.js$/, '')}`;
  const PARAMS = __V2C_PARAMS__;
  const SIZE_ATTRS = ['height', 'max-height', 'loading'];

  class Vid2ContextEmbed extends HTMLElement {
    static get observedAttributes(): string[] {
      return [...PARAMS, ...SIZE_ATTRS];
    }

    private frame: HTMLIFrameElement | undefined;
    private pending: ReturnType<typeof setTimeout> | undefined;
    private readonly onMessage = (e: MessageEvent) => this.receive(e);

    /** The widget address for the current attributes. */
    get src(): string {
      const q = new URLSearchParams();
      for (const name of PARAMS) {
        const v = this.getAttribute(name);
        if (v !== null && v !== '') q.set(name, v);
      }
      const qs = q.toString();
      return `${BASE}/embed/${qs ? `?${qs}` : ''}`;
    }

    connectedCallback(): void {
      if (this.frame) return;
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ':host{display:block;max-width:100%}iframe{display:block;width:100%;border:0;border-radius:12px;background:transparent;transition:height .15s ease}';
      const frame = document.createElement('iframe');
      frame.title = this.getAttribute('title') || 'Video context by vid2context';
      frame.loading = this.getAttribute('loading') === 'eager' ? 'eager' : 'lazy';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write';
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.style.height = `${this.fixedHeight() ?? this.defaultHeight()}px`;
      frame.src = this.src;
      shadow.replaceChildren(style, frame);
      this.frame = frame;
      window.addEventListener('message', this.onMessage);
    }

    disconnectedCallback(): void {
      window.removeEventListener('message', this.onMessage);
      this.shadowRoot?.replaceChildren();
      this.frame = undefined;
    }

    attributeChangedCallback(name: string, before: string | null, after: string | null): void {
      if (!this.frame || before === after) return;
      if (name === 'theme') return this.setTheme((after as 'auto' | 'light' | 'dark') || 'auto');
      if (name === 'height' || name === 'max-height') {
        this.frame.style.height = `${this.fixedHeight() ?? this.defaultHeight()}px`;
        return;
      }
      if (name === 'loading') return;
      // Batch attribute changes made together into one reload.
      clearTimeout(this.pending);
      this.pending = setTimeout(() => {
        if (this.frame) this.frame.src = this.src;
      }, 0);
    }

    /** Scroll the transcript to this time (seconds, "1:15" or "1m15s"), and seek the player when it is on. */
    seek(sec: number | string): void {
      this.send({ type: 'seek', sec });
    }

    /** Set the widget's search box. */
    search(query: string): void {
      this.send({ type: 'search', query });
    }

    setTheme(theme: 'auto' | 'light' | 'dark'): void {
      this.send({ type: 'theme', theme });
    }

    /** Show another video, sample or context file without rebuilding the element. */
    load(target: LoadTarget): void {
      this.send({ type: 'load', ...target });
    }

    private send(msg: Record<string, unknown>): void {
      this.frame?.contentWindow?.postMessage({ target: 'vid2context', ...msg }, ORIGIN);
    }

    private fixedHeight(): number | undefined {
      const h = Number(this.getAttribute('height'));
      return Number.isFinite(h) && h > 0 ? h : undefined;
    }

    private maxHeight(): number {
      const h = Number(this.getAttribute('max-height'));
      return Number.isFinite(h) && h > 0 ? h : 640;
    }

    private defaultHeight(): number {
      const view = this.getAttribute('view') || 'transcript';
      const base = __V2C_HEIGHTS__[view] ?? 480;
      const withPlayer = this.getAttribute('player') === '1' && view !== 'input' ? base + 300 : base;
      return Math.min(withPlayer, view === 'transcript' || view === 'chapters' ? this.maxHeight() : Number.POSITIVE_INFINITY);
    }

    private receive(e: MessageEvent): void {
      if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== ORIGIN) return;
      const msg = e.data as WidgetMessage | null;
      if (!msg || msg.source !== 'vid2context' || typeof msg.type !== 'string') return;
      const { source: _source, type, ...detail } = msg;
      if (type === 'resize' && typeof detail.height === 'number' && this.fixedHeight() === undefined) {
        const view = this.getAttribute('view') || 'transcript';
        const scrolls = view === 'transcript' || view === 'chapters';
        const h = scrolls ? Math.min(detail.height, this.maxHeight()) : detail.height;
        this.frame.style.height = `${Math.max(80, Math.ceil(h))}px`;
      }
      this.dispatchEvent(new CustomEvent(`vid2context:${type}`, { detail, bubbles: true, composed: true }));
    }
  }

  customElements.define('vid2context-embed', Vid2ContextEmbed);

  const api = {
    origin: ORIGIN,
    params: PARAMS.slice(),
    /**
     * Put a widget inside target (an element or a selector). Options are the
     * widget parameters, plus height, max-height and loading.
     */
    embed(target: string | Element, options: Record<string, string | number | boolean> = {}): Vid2ContextEmbed {
      const host = typeof target === 'string' ? document.querySelector(target) : target;
      if (!host) throw new Error(`Vid2Context.embed: no element matches ${String(target)}`);
      const node = document.createElement('vid2context-embed') as Vid2ContextEmbed;
      for (const [k, v] of Object.entries(options)) {
        const name = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        if (v === undefined || v === null || v === '') continue;
        node.setAttribute(name, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
      }
      host.replaceChildren(node);
      return node;
    },
  };
  (window as unknown as { Vid2Context: typeof api }).Vid2Context = api;
})();
