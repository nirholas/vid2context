/**
 * The embed builder on /docs/embed/: every change to the form updates the
 * live preview (a real /embed/ iframe), the widget URL and the five snippets.
 * The preview's postMessage events are logged, and the "drive it" buttons send
 * the same commands an embedding page can send. The setup is kept in the URL
 * hash (#embed=...) so a link reproduces it.
 */
import {
  BUILDER_START,
  checkParam,
  EMBED_PARAMS,
  type EmbedParams,
  embedDefaults,
  embedUrl,
  MESSAGE_SOURCE,
  parseEmbedParams,
  parseSeconds,
  SNIPPETS,
  suggestedHeight,
} from '../lib/embed.ts';

const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const SOURCES = ['url', 'sample', 'src'];

const PRESETS: Record<string, Partial<EmbedParams>> = {
  transcript: { view: 'transcript', player: '0', header: '1', search: '1', tools: '1' },
  player: { view: 'transcript', player: '1', header: '1', search: '1', tools: '1' },
  chapters: { view: 'chapters', player: '0', sample: 'zoo', url: '', src: '' },
  quote: { view: 'quote', player: '0', start: '5', end: '13', sample: 'zoo', url: '', src: '' },
  card: { view: 'card', player: '0' },
  input: { view: 'input', player: '0' },
};

function setup(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>('.eb-form');
  const frame = root.querySelector<HTMLIFrameElement>('[data-eb-frame]');
  const errorBox = root.querySelector<HTMLElement>('[data-eb-error]');
  const urlOut = root.querySelector<HTMLElement>('[data-eb-url]');
  const openLink = root.querySelector<HTMLAnchorElement>('[data-eb-open]');
  const log = root.querySelector<HTMLOListElement>('[data-eb-log]');
  const heightInput = root.querySelector<HTMLInputElement>('#eb-height');
  const swatch = root.querySelector<HTMLInputElement>('.eb-swatch');
  if (!form || !frame || !errorBox || !urlOut || !openLink || !log || !heightInput) return;

  const origin = location.origin;
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
  let current: EmbedParams = { ...BUILDER_START };
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let fixedHeight: number | undefined;

  function write(params: EmbedParams): void {
    for (const p of EMBED_PARAMS) {
      const el = input(p.name);
      if (!el) continue;
      const v = params[p.name] ?? p.default;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = v === '1';
      else el.value = v;
    }
    syncSwatch();
  }

  function read(): { params: EmbedParams; errors: string[] } {
    const params = embedDefaults();
    const errors: string[] = [];
    for (const p of EMBED_PARAMS) {
      const el = input(p.name);
      if (!el) continue;
      const raw = el instanceof HTMLInputElement && el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
      const r = checkParam(p.name, raw);
      el.toggleAttribute('aria-invalid', 'error' in r);
      if ('error' in r) errors.push(r.error);
      else params[p.name] = r.value;
    }
    if (params.start && params.end && Number(params.end) <= Number(params.start)) {
      errors.push('End must be after start.');
      params.end = '';
    }
    const h = heightInput?.value.trim() ?? '';
    fixedHeight = undefined;
    heightInput?.removeAttribute('aria-invalid');
    if (h) {
      const n = Number(h);
      if (Number.isInteger(n) && n >= 80 && n <= 4000) fixedHeight = n;
      else {
        errors.push('Height must be a whole number of pixels between 80 and 4000.');
        heightInput?.setAttribute('aria-invalid', 'true');
      }
    }
    if (params.view !== 'input' && !params.url && !params.sample && !params.src) errors.push('Pick a sample, or enter a video URL or a context JSON URL.');
    return { params, errors };
  }

  function syncSwatch(): void {
    const accent = input('accent')?.value.replace(/^#/, '') ?? '';
    if (swatch && /^[0-9a-f]{6}$/i.test(accent)) swatch.value = `#${accent}`;
  }

  /** userChange: only a change the reader made rewrites the hash, so loading the page keeps any #anchor. */
  function update(userChange = true): void {
    const { params, errors } = read();
    current = params;
    errorBox.hidden = errors.length === 0;
    errorBox.textContent = errors.join(' ');
    const height = fixedHeight ?? suggestedHeight(params);
    for (const s of SNIPPETS) {
      const out = root.querySelector<HTMLElement>(`[data-eb-out="${s.id}"]`);
      if (!out) continue;
      let text = s.build(origin, params);
      if (s.id === 'iframe') text = text.replace(/height="\d+"/, `height="${height}"`);
      if (s.id === 'react') text = text.replace(/height=\{\d+\}/, `height={${height}}`);
      if (s.id === 'component' && fixedHeight) text = text.replace(/<vid2context-embed/, `<vid2context-embed height="${fixedHeight}"`);
      out.textContent = text;
    }
    const absolute = embedUrl(origin, params);
    urlOut.textContent = absolute;
    openLink.href = absolute;
    heightInput?.setAttribute('placeholder', `auto (${suggestedHeight(params)})`);
    const src = `${BASE}${embedUrl('', params)}`;
    clearTimeout(frameTimer);
    frameTimer = setTimeout(() => {
      if (frame.getAttribute('src') !== src) frame.src = src;
      frame.style.height = `${height}px`;
    }, 250);
    const hash = `#embed=${encodeURIComponent(new URLSearchParams(embedUrl('', params).split('?')[1] ?? '').toString())}${fixedHeight ? `&height=${fixedHeight}` : ''}`;
    if (userChange) history.replaceState(null, '', hash);
  }

  // One source at a time: typing a URL clears the sample, and so on.
  form.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target === swatch) {
      const accent = input('accent');
      if (accent) accent.value = swatch.value.replace(/^#/, '');
    } else if (SOURCES.includes(target.name) && target.value.trim()) {
      for (const other of SOURCES) {
        const el = input(other);
        if (other !== target.name && el) el.value = '';
      }
    }
    if (target.name === 'accent') syncSwatch();
    update();
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      const preset = PRESETS[b.dataset.preset ?? ''];
      if (!preset) return;
      const next = { ...current, start: '', end: '', ...preset };
      if (!next.url && !next.sample && !next.src && next.view !== 'input') next.sample = 'zoo';
      write(next);
      update();
    });
  });

  root.querySelector('[data-eb-reset]')?.addEventListener('click', () => {
    heightInput.value = '';
    write(BUILDER_START);
    update();
  });

  root.querySelector<HTMLButtonElement>('[data-eb-share]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(location.href);
      b.textContent = 'Link copied';
    } catch {
      b.textContent = 'Copy the address bar';
    }
    setTimeout(() => {
      b.textContent = 'Copy link to this setup';
    }, 1800);
  });

  // Snippet tabs: arrow keys move between them, as in the runnable blocks.
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('.eb-tabs [role="tab"]')];
  function select(tab: HTMLButtonElement): void {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = root.querySelector<HTMLElement>(`#${t.getAttribute('aria-controls')}`);
      if (panel) panel.hidden = !on;
    }
  }
  for (const t of tabs) {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(t);
      const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : undefined;
      if (!next) return;
      e.preventDefault();
      select(next);
      next.focus();
    });
  }

  root.querySelectorAll<HTMLButtonElement>('[data-eb-copy]').forEach((b) => {
    b.addEventListener('click', async () => {
      const text = root.querySelector<HTMLElement>(`[data-eb-out="${b.dataset.ebCopy}"]`)?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Select and copy';
      }
      setTimeout(() => {
        b.textContent = 'Copy';
      }, 1800);
    });
  });

  // Commands to the preview, exactly as an embedding page sends them.
  const send = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage({ target: MESSAGE_SOURCE, ...msg }, origin);
  root.querySelectorAll<HTMLButtonElement>('[data-eb-cmd]').forEach((b) => {
    b.addEventListener('click', () => {
      const cmd = b.dataset.ebCmd;
      if (cmd === 'seek') {
        const raw = root.querySelector<HTMLInputElement>('#eb-cmd-seek')?.value ?? '';
        const sec = parseSeconds(raw);
        if (sec === undefined) {
          errorBox.hidden = false;
          errorBox.textContent = 'Seek needs seconds, m:ss or 1m15s.';
          return;
        }
        send({ type: 'seek', sec });
      } else if (cmd === 'search') send({ type: 'search', query: root.querySelector<HTMLInputElement>('#eb-cmd-search')?.value ?? '' });
      else if (cmd === 'theme') send({ type: 'theme', theme: b.dataset.themeValue });
    });
  });

  // Events from the preview.
  const started = performance.now();
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || e.origin !== origin) return;
    const msg = e.data as { source?: string; type?: string; [k: string]: unknown } | null;
    if (!msg || msg.source !== MESSAGE_SOURCE || typeof msg.type !== 'string') return;
    const { source: _s, type, ...detail } = msg;
    if (type === 'resize' && typeof detail.height === 'number' && !fixedHeight) {
      const scrolls = current.view === 'transcript' || current.view === 'chapters';
      frame.style.height = `${Math.max(80, Math.ceil(scrolls ? Math.min(detail.height, 640) : detail.height))}px`;
    }
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'eb-log-time';
    time.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
    const name = document.createElement('code');
    name.textContent = type;
    const body = document.createElement('span');
    const json = JSON.stringify(detail);
    body.textContent = json.length > 160 ? `${json.slice(0, 157)}...` : json;
    li.append(time, name, body);
    li.dataset.type = type;
    log.prepend(li);
    while (log.children.length > 40) log.lastElementChild?.remove();
  });
  root.querySelector('[data-eb-clear]')?.addEventListener('click', () => log.replaceChildren());

  // Restore a shared setup from the hash.
  const m = location.hash.match(/^#embed=([^&]*)(?:&height=(\d+))?/);
  if (m) {
    const parsed = parseEmbedParams(decodeURIComponent(m[1] ?? ''));
    write(parsed.params);
    if (m[2]) heightInput.value = m[2];
  } else write(BUILDER_START);
  update(false);
  root.dataset.ready = 'true';
}

for (const root of document.querySelectorAll<HTMLElement>('[data-widget="embed-builder"]')) setup(root);

// ------------------------------------------------------------------ gallery

const galleryFrames = [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-eb-auto]')];
if (galleryFrames.length) {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== location.origin) return;
    const frame = galleryFrames.find((f) => f.contentWindow === e.source);
    const msg = e.data as { source?: string; type?: string; height?: unknown } | null;
    if (!frame || msg?.source !== MESSAGE_SOURCE || msg.type !== 'resize' || typeof msg.height !== 'number') return;
    const view = frame.dataset.ebAuto;
    const h = view === 'transcript' || view === 'chapters' ? Math.min(msg.height, 420) : msg.height;
    frame.style.height = `${Math.max(80, Math.ceil(h))}px`;
  });
}

// ------------------------------------------------------------------ the web component, live

interface EmbedElement extends HTMLElement {
  seek(sec: number | string): void;
  search(query: string): void;
  load(target: { sample: string }): void;
}

const componentDemos = [...document.querySelectorAll<HTMLElement>('[data-widget="embed-component"]')];
if (componentDemos.length) {
  const script = document.createElement('script');
  script.src = `${BASE}/embed.js`;
  script.async = true;
  script.addEventListener('load', () => {
    for (const demo of componentDemos) {
      const stage = demo.querySelector<HTMLElement>('[data-ec-stage]');
      const log = demo.querySelector<HTMLOListElement>('[data-ec-log]');
      if (!stage || !log) continue;
      const el = document.createElement('vid2context-embed') as EmbedElement;
      el.setAttribute('sample', 'gwagon');
      el.setAttribute('max-height', '420');
      el.setAttribute('loading', 'eager');
      const started = performance.now();
      for (const type of ['ready', 'loaded', 'segment', 'seek', 'search', 'error']) {
        el.addEventListener(`vid2context:${type}`, (e) => {
          const li = document.createElement('li');
          const time = document.createElement('span');
          time.className = 'eb-log-time';
          time.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
          const name = document.createElement('code');
          name.textContent = `vid2context:${type}`;
          const body = document.createElement('span');
          const json = JSON.stringify((e as CustomEvent).detail);
          body.textContent = json.length > 140 ? `${json.slice(0, 137)}...` : json;
          li.append(time, name, body);
          log.prepend(li);
          while (log.children.length > 40) log.lastElementChild?.remove();
        });
      }
      stage.replaceChildren(el);
      demo.querySelectorAll<HTMLButtonElement>('[data-ec]').forEach((b) => {
        b.addEventListener('click', () => {
          const arg = b.dataset.arg ?? '';
          if (b.dataset.ec === 'seek') el.seek(Number(arg));
          else if (b.dataset.ec === 'search') el.search(arg);
          else if (b.dataset.ec === 'theme') el.setAttribute('theme', arg);
          else if (b.dataset.ec === 'load') el.load({ sample: arg });
        });
      });
      demo.querySelector('[data-ec-clear]')?.addEventListener('click', () => log.replaceChildren());
      demo.dataset.ready = 'true';
    }
  });
  script.addEventListener('error', () => {
    for (const demo of componentDemos) {
      const stage = demo.querySelector('[data-ec-stage]');
      if (stage) stage.textContent = 'Could not load /embed.js from this site.';
    }
  });
  document.head.append(script);
}
