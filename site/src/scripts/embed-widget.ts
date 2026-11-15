/**
 * The embeddable widget at /embed/. Reads its parameters from the query
 * string (src/lib/embed.ts), loads a VideoContext (a recorded sample, a JSON
 * file, or the API), renders the chosen view, and talks to its parent page
 * with postMessage: events out, commands in.
 *
 * All text from the context is set with textContent, never as HTML.
 */
import type { Chapter, Segment, VideoContext } from '@vid2context/core';
import {
  clock,
  EMBED_THEMES,
  type EmbedParams,
  type EmbedView,
  MESSAGE_SOURCE,
  parseEmbedParams,
  parseSeconds,
} from '../lib/embed.ts';

const PROTOCOL = 1;
const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const root = document.getElementById('w') as HTMLDivElement;

interface WidgetError {
  code: string;
  message: string;
  hint?: string;
}

// ------------------------------------------------------------------ messaging

const embedded = window.parent !== window;

function post(type: string, detail: Record<string, unknown> = {}): void {
  if (!embedded) return;
  // Everything the widget posts is public (the transcript it shows), so any parent may read it.
  window.parent.postMessage({ source: MESSAGE_SOURCE, type, ...detail }, '*');
}

// ------------------------------------------------------------------ helpers

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

const isHttps = (u: string | undefined): u is string => !!u && /^https:\/\//.test(u);

function youtubeId(ctx: VideoContext): string | undefined {
  const ref = ctx.metadata.ref;
  if (ref.platform !== 'youtube') return undefined;
  const id = ref.nativeId ?? ref.id?.replace(/^youtube:/, '');
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}

/** A link that opens the video at this moment, where the platform supports it. */
function linkAt(ctx: VideoContext, sec: number): string | undefined {
  const url = ctx.metadata.ref.url;
  if (!isHttps(url)) return undefined;
  const yt = youtubeId(ctx);
  if (yt) return `https://www.youtube.com/watch?v=${yt}&t=${Math.floor(sec)}s`;
  if (/vimeo\.com\//.test(url)) return `${url.split('#')[0]}#t=${Math.floor(sec)}s`;
  return url;
}

function appUrl(videoUrl: string): string {
  return `${location.origin}${BASE}/app/?url=${encodeURIComponent(videoUrl)}`;
}

function inRange(seg: { startSec: number; endSec?: number }, p: EmbedParams): boolean {
  const start = p.start ? Number(p.start) : undefined;
  const end = p.end ? Number(p.end) : undefined;
  if (start !== undefined && (seg.endSec ?? seg.startSec) <= start) return false;
  if (end !== undefined && seg.startSec >= end) return false;
  return true;
}

function applyAccent(hex: string): void {
  const style = document.documentElement.style;
  if (!hex) {
    style.removeProperty('--w-accent');
    style.removeProperty('--w-accent-fg');
    return;
  }
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  style.setProperty('--w-accent', `#${full}`);
  style.setProperty('--w-accent-fg', luminance > 0.4 ? '#0a0a0a' : '#ffffff');
}

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme === 'light' || theme === 'dark' ? theme : 'system';
}

// ------------------------------------------------------------------ loading

function isContext(v: unknown): v is VideoContext {
  const c = v as VideoContext | null;
  return !!c && typeof c.metadata?.title === 'string' && Array.isArray(c.transcript?.segments);
}

async function readError(res: Response): Promise<WidgetError> {
  try {
    const body = (await res.json()) as { error?: WidgetError };
    if (body?.error?.code) return body.error;
  } catch {
    // Not JSON: fall through to the status line.
  }
  return { code: `http_${res.status}`, message: `The server answered ${res.status} ${res.statusText}.` };
}

async function loadContext(p: EmbedParams, signal: AbortSignal): Promise<VideoContext> {
  let request: string;
  let where: string;
  if (p.sample) {
    request = `${BASE}/embed/samples/${p.sample}.json`;
    where = 'this site';
  } else if (p.src) {
    request = p.src;
    where = new URL(p.src).host;
  } else {
    const api = (p.api || location.origin).replace(/\/$/, '');
    const q = new URLSearchParams({ url: p.url });
    if (p.lang) q.set('lang', p.lang);
    if (p.mode && p.mode !== 'auto') q.set('mode', p.mode);
    request = `${api}/api/v1/context?${q}`;
    where = new URL(api).host;
  }
  let res: Response;
  try {
    res = await fetch(request, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw {
      code: 'network',
      message: `Could not reach ${where}.`,
      hint: p.src || p.api ? 'Check the address, and that the server sends Access-Control-Allow-Origin for this page.' : 'Check your connection and try again.',
    } satisfies WidgetError;
  }
  if (!res.ok) throw await readError(res);
  const body: unknown = await res.json().catch(() => undefined);
  if (!isContext(body)) {
    throw { code: 'bad_context', message: 'The response is not a VideoContext.', hint: 'Point src at the JSON from `vid2context get <url> --format json` or GET /api/v1/context.' } satisfies WidgetError;
  }
  return body;
}

// ------------------------------------------------------------------ state

let params: EmbedParams = parseEmbedParams(location.search).params;
let context: VideoContext | undefined;
let segments: Segment[] = [];
let chapters: Chapter[] = [];
let tab: 'transcript' | 'chapters' = 'transcript';
let query = '';
let activeIndex = -1;
let loadAbort: AbortController | undefined;
let player: HTMLIFrameElement | undefined;
let lastUserScroll = 0;

// ------------------------------------------------------------------ rendering

function header(ctx: VideoContext): HTMLElement {
  const m = ctx.metadata;
  const bits = [m.channel?.name, m.durationSec ? clock(m.durationSec) : undefined, ctx.transcript.language?.toUpperCase()].filter(Boolean);
  const link = isHttps(m.ref.url) ? el('a', { href: m.ref.url, target: '_blank', rel: 'noopener', text: m.title }) : m.title;
  return el(
    'header',
    { class: 'w-head' },
    el('div', {}, el('h1', { class: 'w-title' }, link), bits.length ? el('p', { class: 'w-sub', text: bits.join(' · ') }) : null),
    el('span', { class: 'w-badge', title: 'How the transcript was made', text: ctx.transcript.origin.replace(/-/g, ' ') }),
  );
}

function playerFrame(ctx: VideoContext): HTMLElement | null {
  const id = youtubeId(ctx);
  if (params.player !== '1' || !id) return null;
  const start = params.start ? `&start=${Math.floor(Number(params.start))}` : '';
  const frame = el('iframe', {
    src: `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&playsinline=1&rel=0&origin=${encodeURIComponent(location.origin)}${start}`,
    title: `Video: ${ctx.metadata.title}`,
    allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
    allowfullscreen: true,
    referrerpolicy: 'strict-origin-when-cross-origin',
  });
  frame.addEventListener('load', () => {
    frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), 'https://www.youtube-nocookie.com');
  });
  player = frame;
  return el('div', { class: 'w-player' }, frame);
}

function highlighted(text: string): (Node | string)[] {
  if (!query) return [text];
  const out: (Node | string)[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(el('mark', { text: text.slice(i, i + q.length) }));
    at = i + q.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function lineItem(ctx: VideoContext, item: { startSec: number; endSec?: number; text: string }, index: number, kind: 'segment' | 'chapter'): HTMLLIElement {
  const showTs = params.timestamps === '1' || kind === 'chapter';
  const href = params.player === '1' && player ? undefined : linkAt(ctx, item.startSec);
  const ts = showTs
    ? href
      ? el('a', { class: 'w-ts', href, target: '_blank', rel: 'noopener', 'aria-label': `Open the video at ${clock(item.startSec)}`, text: clock(item.startSec) })
      : el('span', { class: 'w-ts', text: clock(item.startSec) })
    : null;
  const button = el('button', { type: 'button', class: `w-tx${kind === 'chapter' ? ' w-chapter-title' : ''}`, 'data-i': String(index), 'data-kind': kind });
  button.append(...highlighted(item.text));
  return el('li', { class: `w-line${showTs ? '' : ' no-ts'}`, 'data-start': String(item.startSec) }, ts, button);
}

function transcriptList(ctx: VideoContext): HTMLElement {
  const visible = segments.map((s, i) => [s, i] as const).filter(([s]) => !query || s.text.toLowerCase().includes(query.toLowerCase()));
  post('search', { query, matches: query ? visible.length : segments.length });
  const count = document.querySelector('.w-count');
  if (count) count.textContent = query ? `${visible.length} of ${segments.length}` : `${segments.length} lines`;
  if (!visible.length) return el('p', { class: 'w-empty', role: 'status', text: query ? `No line contains "${query}".` : 'This transcript is empty.' });
  return el('ol', { class: 'w-list', 'aria-label': 'Transcript' }, ...visible.map(([s, i]) => lineItem(ctx, s, i, 'segment')));
}

function chapterList(ctx: VideoContext): HTMLElement {
  if (!chapters.length) return el('p', { class: 'w-empty', text: 'This video has no chapters.' });
  return el(
    'ol',
    { class: 'w-list', 'aria-label': 'Chapters' },
    ...chapters.map((c, i) => lineItem(ctx, { startSec: c.startSec, endSec: c.endSec, text: c.title }, i, 'chapter')),
  );
}

function renderBody(): void {
  const body = root.querySelector('.w-body');
  if (!body || !context) return;
  body.replaceChildren(tab === 'chapters' ? chapterList(context) : transcriptList(context));
  activeIndex = -1;
  postResize();
}

function toolbar(view: EmbedView): HTMLElement | null {
  const showTabs = view === 'transcript' && chapters.length > 0;
  const showSearch = view === 'transcript' && params.search === '1';
  if (!showTabs && !showSearch) return null;
  const bar = el('div', { class: 'w-bar' });
  if (showTabs) {
    const tabs = el('div', { class: 'w-tabs', role: 'tablist', 'aria-label': 'Show' });
    for (const t of ['transcript', 'chapters'] as const) {
      const b = el('button', { type: 'button', class: 'w-tab', role: 'tab', 'aria-selected': String(tab === t), 'data-tab': t, text: t === 'transcript' ? 'Transcript' : `Chapters (${chapters.length})` });
      b.addEventListener('click', () => {
        tab = t;
        for (const x of tabs.querySelectorAll('.w-tab')) x.setAttribute('aria-selected', String(x === b));
        const search = root.querySelector<HTMLInputElement>('.w-search');
        if (search) search.hidden = t === 'chapters';
        renderBody();
      });
      tabs.append(b);
    }
    bar.append(tabs);
  }
  if (showSearch) {
    const input = el('input', { class: 'w-search', type: 'search', placeholder: 'Search the transcript', 'aria-label': 'Search the transcript', value: query });
    let timer: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        query = input.value.trim();
        renderBody();
      }, 120);
    });
    bar.append(input, el('span', { class: 'w-count', 'aria-live': 'polite' }));
  }
  return bar;
}

function plainText(withTs: boolean): string {
  return segments.map((s) => (withTs ? `[${clock(s.startSec)}] ${s.text}` : s.text)).join('\n');
}

function srt(): string {
  const t = (sec: number) => {
    const ms = Math.round(sec * 1000);
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
  };
  return segments.map((s, i) => `${i + 1}\n${t(s.startSec)} --> ${t(s.endSec)}\n${s.text}\n`).join('\n');
}

function download(name: string, type: string, text: string): void {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function fileBase(ctx: VideoContext): string {
  return ctx.metadata.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'transcript';
}

function footer(ctx: VideoContext, view: EmbedView): HTMLElement | null {
  const showTools = params.tools === '1' && (view === 'transcript' || view === 'chapters');
  if (!showTools && params.branding !== '1') return null;
  const foot = el('footer', { class: 'w-foot' });
  if (showTools) {
    const actions = el('div', { class: 'w-actions' });
    const copy = el('button', { type: 'button', class: 'w-btn', 'data-action': 'copy', text: 'Copy' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(plainText(params.timestamps === '1'));
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Copy blocked';
      }
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1600);
    });
    const name = fileBase(ctx);
    const files: [string, () => void][] = [
      ['.txt', () => download(`${name}.txt`, 'text/plain', plainText(true))],
      ['.srt', () => download(`${name}.srt`, 'application/x-subrip', srt())],
      ['.json', () => download(`${name}.json`, 'application/json', JSON.stringify(ctx, null, 2))],
    ];
    actions.append(copy);
    for (const [label, run] of files) {
      const b = el('button', { type: 'button', class: 'w-btn', 'data-action': `download${label}`, 'aria-label': `Download ${label.slice(1).toUpperCase()}`, text: label });
      b.addEventListener('click', run);
      actions.append(b);
    }
    if (isHttps(ctx.metadata.ref.url)) actions.append(el('a', { class: 'w-btn', href: appUrl(ctx.metadata.ref.url), target: '_blank', rel: 'noopener', text: 'Open in app' }));
    foot.append(actions);
  }
  if (params.branding === '1') foot.append(el('a', { class: 'w-credit', href: `${location.origin}${BASE}/`, target: '_blank', rel: 'noopener', text: 'Context by vid2context' }));
  return foot;
}

function quoteView(ctx: VideoContext): HTMLElement {
  const picked = params.start || params.end ? segments.filter((s) => inRange(s, params)) : segments.slice(0, 3);
  if (!picked.length) return el('p', { class: 'w-empty', text: 'No lines between start and end.' });
  const from = picked[0]?.startSec ?? 0;
  const to = picked[picked.length - 1]?.endSec ?? from;
  const href = linkAt(ctx, from);
  const where = `${clock(from)} to ${clock(to)}`;
  return el(
    'figure',
    { class: 'w-quote' },
    el('blockquote', { text: picked.map((s) => s.text).join(' ') }),
    el(
      'figcaption',
      {},
      ctx.metadata.title,
      ctx.metadata.channel?.name ? `, ${ctx.metadata.channel.name}` : '',
      ', ',
      href ? el('a', { href, target: '_blank', rel: 'noopener', text: where }) : where,
    ),
  );
}

function cardView(ctx: VideoContext): HTMLElement {
  const m = ctx.metadata;
  const card = el('div', { class: 'w-card' });
  const yt = youtubeId(ctx);
  const thumb = yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : isHttps(m.thumbnailUrl) ? m.thumbnailUrl : undefined;
  if (thumb) card.append(el('img', { src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', width: '480', height: '270' }));
  if (chapters.length) {
    card.append(el('ol', { 'aria-label': 'Chapters' }, ...chapters.slice(0, 8).map((c, i) => lineItem(ctx, { startSec: c.startSec, text: c.title }, i, 'chapter'))));
  } else {
    const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    card.append(el('p', { class: 'w-sub', text: `${segments.length} transcript lines, about ${words.toLocaleString('en')} words.` }));
  }
  const actions = el('div', { class: 'w-actions' });
  if (isHttps(m.ref.url)) {
    actions.append(el('a', { class: 'w-btn primary', href: appUrl(m.ref.url), target: '_blank', rel: 'noopener', text: 'Read the transcript' }));
    actions.append(el('a', { class: 'w-btn', href: m.ref.url, target: '_blank', rel: 'noopener', text: 'Watch' }));
  }
  card.append(actions);
  return card;
}

function inputView(): HTMLElement {
  const form = el('form', { class: 'w-form', action: `${location.origin}${BASE}/app/`, method: 'get', target: '_blank' });
  const id = 'w-input-url';
  form.append(
    el('label', { for: id, text: 'Turn a video into context for AI' }),
    el('input', { id, name: 'url', type: 'url', required: true, placeholder: 'Paste a YouTube, Vimeo or podcast link', value: params.url, autocomplete: 'off' }),
    el('button', { type: 'submit', class: 'w-btn primary', text: 'Get context' }),
  );
  return form;
}

function showError(err: WidgetError): void {
  root.dataset.state = 'error';
  root.removeAttribute('aria-busy');
  root.replaceChildren(
    el(
      'div',
      { class: 'w-error', role: 'alert' },
      el('h1', { text: err.message }),
      err.hint ? el('p', { text: err.hint }) : null,
      el('p', {}, el('code', { text: err.code })),
      params.url ? el('p', {}, el('a', { href: appUrl(params.url), target: '_blank', rel: 'noopener', text: 'Try it in the vid2context app' })) : null,
    ),
  );
  post('error', { code: err.code, message: err.message, hint: err.hint });
  postResize();
}

function render(): void {
  const view = params.view as EmbedView;
  root.className = `w${params.compact === '1' ? ' compact' : ''}`;
  root.dataset.view = view;
  root.removeAttribute('aria-busy');
  player = undefined;
  if (view === 'input') {
    root.dataset.state = 'ready';
    root.replaceChildren(inputView(), ...(params.branding === '1' ? [el('footer', { class: 'w-foot' }, el('span'), el('a', { class: 'w-credit', href: `${location.origin}${BASE}/`, target: '_blank', rel: 'noopener', text: 'vid2context' }))] : []));
    postResize();
    return;
  }
  const ctx = context;
  if (!ctx) return;
  root.dataset.state = 'ready';
  const parts: (HTMLElement | null)[] = [params.header === '1' ? header(ctx) : null, view === 'card' ? null : playerFrame(ctx)];
  if (view === 'quote') parts.push(quoteView(ctx));
  else if (view === 'card') parts.push(cardView(ctx));
  else {
    if (view === 'chapters') tab = 'chapters';
    parts.push(toolbar(view), el('div', { class: 'w-body', tabindex: '-1' }));
  }
  parts.push(footer(ctx, view));
  root.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
  if (view === 'transcript' || view === 'chapters') renderBody();
  postResize();
}

async function load(): Promise<void> {
  loadAbort?.abort();
  const parsed = parseEmbedParams(location.search);
  params = parsed.params;
  applyTheme(params.theme);
  applyAccent(params.accent);
  post('ready', { protocol: PROTOCOL });
  if (parsed.errors.length) {
    showError({ code: 'bad_param', message: parsed.errors.join(' '), hint: 'See the parameter list at vid2context.com/docs/embed/parameters/.' });
    return;
  }
  if (params.view === 'input') {
    render();
    return;
  }
  if (!params.url && !params.sample && !params.src) {
    showError({ code: 'no_video', message: 'No video to show.', hint: 'Add ?url=<video link>, ?sample=zoo or ?src=<context JSON URL> to the widget address.' });
    return;
  }
  root.dataset.state = 'loading';
  root.setAttribute('aria-busy', 'true');
  root.replaceChildren(el('p', { class: 'w-status', role: 'status', text: params.url ? 'Fetching the transcript. Long videos can take a moment.' : 'Loading video context' }));
  const abort = new AbortController();
  loadAbort = abort;
  try {
    const ctx = await loadContext(params, abort.signal);
    if (abort.signal.aborted) return;
    context = ctx;
    segments = ctx.transcript.segments.filter((s) => inRange(s, params));
    chapters = (ctx.metadata.chapters ?? []).filter((c) => inRange(c, params));
    tab = 'transcript';
    query = '';
    render();
    post('loaded', {
      title: ctx.metadata.title,
      url: ctx.metadata.ref.url,
      durationSec: ctx.metadata.durationSec,
      segments: segments.length,
      chapters: chapters.length,
      language: ctx.transcript.language,
      origin: ctx.transcript.origin,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    const e = err as WidgetError;
    showError(e.code ? e : { code: 'unexpected', message: String((err as Error).message ?? err) });
  }
}

// ------------------------------------------------------------------ interaction

function seekTo(sec: number, fromPlayer = false): void {
  if (!fromPlayer && player?.contentWindow) {
    const cmd = (func: string, args: unknown[] = []) =>
      player?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), 'https://www.youtube-nocookie.com');
    cmd('seekTo', [sec, true]);
    cmd('playVideo');
  }
  markActive(sec, !fromPlayer || Date.now() - lastUserScroll > 4000);
}

/** The last segment that starts at or before sec. */
function indexAt(sec: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((segments[mid]?.startSec ?? 0) <= sec) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function markActive(sec: number, scroll: boolean): void {
  if (tab !== 'transcript') return;
  const i = indexAt(sec);
  if (i === activeIndex) return;
  activeIndex = i;
  for (const li of root.querySelectorAll('.w-line[aria-current]')) li.removeAttribute('aria-current');
  const li = root.querySelector(`.w-tx[data-kind="segment"][data-i="${i}"]`)?.closest('.w-line');
  if (!li) return;
  li.setAttribute('aria-current', 'true');
  if (scroll) li.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const seg = segments[i];
  if (seg) post('seek', { sec, index: i });
}

root.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('.w-tx');
  if (!b) return;
  const i = Number(b.dataset.i);
  const item = b.dataset.kind === 'chapter' ? chapters[i] : segments[i];
  if (!item) return;
  const text = 'text' in item ? item.text : item.title;
  post('segment', { startSec: item.startSec, endSec: item.endSec, text });
  if (b.dataset.kind === 'chapter' && params.view === 'transcript' && chapters.length) {
    const toTranscript = root.querySelector<HTMLButtonElement>('.w-tab[data-tab="transcript"]');
    toTranscript?.click();
  }
  seekTo(item.startSec);
});

root.addEventListener('wheel', () => {
  lastUserScroll = Date.now();
}, { passive: true });
root.addEventListener('touchmove', () => {
  lastUserScroll = Date.now();
}, { passive: true });

window.addEventListener('message', (e: MessageEvent) => {
  // The YouTube player reports its time as a JSON string.
  if (player && e.source === player.contentWindow && e.origin === 'https://www.youtube-nocookie.com' && typeof e.data === 'string') {
    try {
      const msg = JSON.parse(e.data) as { event?: string; info?: { currentTime?: number } };
      if (msg.event === 'infoDelivery' && typeof msg.info?.currentTime === 'number') seekTo(msg.info.currentTime, true);
    } catch {
      // Not a player message.
    }
    return;
  }
  // Commands from the page that embeds the widget.
  if (!embedded || e.source !== window.parent) return;
  const msg = e.data as { target?: string; type?: string; [k: string]: unknown } | null;
  if (!msg || msg.target !== MESSAGE_SOURCE) return;
  switch (msg.type) {
    case 'seek': {
      const sec = typeof msg.sec === 'number' ? msg.sec : parseSeconds(String(msg.sec ?? ''));
      if (sec !== undefined && context) seekTo(sec);
      break;
    }
    case 'search': {
      const input = root.querySelector<HTMLInputElement>('.w-search');
      query = String(msg.query ?? '').trim();
      if (input) input.value = query;
      if (tab !== 'transcript') root.querySelector<HTMLButtonElement>('.w-tab[data-tab="transcript"]')?.click();
      else renderBody();
      break;
    }
    case 'theme':
      if (EMBED_THEMES.includes(msg.theme as never)) applyTheme(String(msg.theme));
      break;
    case 'load': {
      const next = new URLSearchParams(location.search);
      for (const k of ['url', 'sample', 'src']) next.delete(k);
      for (const k of ['url', 'sample', 'src']) if (typeof msg[k] === 'string' && msg[k]) next.set(k, String(msg[k]));
      history.replaceState(null, '', `${location.pathname}?${next}`);
      void load();
      break;
    }
  }
});

// ------------------------------------------------------------------ size

let lastHeight = 0;

/** The height the widget would need with no inner scrolling, so the parent can size the iframe. */
function naturalHeight(): number {
  const body = root.querySelector<HTMLElement>('.w-body');
  const outer = root.scrollHeight + 2;
  return Math.ceil(body ? outer - body.clientHeight + body.scrollHeight : outer);
}

function postResize(): void {
  requestAnimationFrame(() => {
    const h = naturalHeight();
    if (h === lastHeight) return;
    lastHeight = h;
    post('resize', { height: h });
  });
}

if (embedded && 'ResizeObserver' in window) new ResizeObserver(postResize).observe(root);

void load();
