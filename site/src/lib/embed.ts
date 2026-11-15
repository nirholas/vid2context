/**
 * The embeddable widget's contract, shared by the build (docs tables, the
 * builder's static markup), the widget page (/embed/), the builder in the docs
 * and the loader script (/embed.js). One list of parameters, one way to read
 * them, one way to write an embed URL and its snippets.
 *
 * Runs in the browser and in Node: no node:* imports, no DOM at module scope.
 */

export type EmbedView = 'transcript' | 'chapters' | 'quote' | 'card' | 'input';
export type EmbedTheme = 'auto' | 'light' | 'dark';

export interface EmbedParam {
  name: string;
  /** Attribute name on <vid2context-embed> (same as name unless noted). */
  label: string;
  type: 'url' | 'text' | 'select' | 'flag' | 'seconds' | 'color' | 'sample';
  default: string;
  options?: string[];
  /** One plain sentence for the docs table and the builder's help text. */
  help: string;
  /** Builder group. */
  group: 'source' | 'look' | 'show' | 'range';
}

/** Real fixture contexts the site serves at /embed/samples/<id>.json (tests/fixtures/contexts). */
export const EMBED_SAMPLES: { id: string; file: string; label: string; url: string }[] = [
  {
    id: 'zoo',
    file: 'youtube-jNQXAC9IVRw.json',
    label: 'Me at the zoo (0:19, three chapters)',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  },
  {
    id: 'gwagon',
    file: 'youtube-cCPsdFdlshc.json',
    label: 'G-Wagon buyer guide (18 min)',
    url: 'https://www.youtube.com/watch?v=cCPsdFdlshc',
  },
];

export const EMBED_VIEWS: EmbedView[] = ['transcript', 'chapters', 'quote', 'card', 'input'];
export const EMBED_THEMES: EmbedTheme[] = ['auto', 'light', 'dark'];
export const EMBED_MODES = ['auto', 'captions', 'stt', 'video'];

export const EMBED_PARAMS: EmbedParam[] = [
  {
    name: 'url',
    label: 'Video URL',
    type: 'url',
    default: '',
    help: 'Any video link vid2context understands. The widget fetches its context from the API when it loads.',
    group: 'source',
  },
  {
    name: 'sample',
    label: 'Sample',
    type: 'sample',
    default: '',
    options: EMBED_SAMPLES.map((s) => s.id),
    help: 'A recorded context served by the site (zoo or gwagon). Needs no API call; good for trying layouts.',
    group: 'source',
  },
  {
    name: 'src',
    label: 'Context JSON URL',
    type: 'url',
    default: '',
    help: 'A VideoContext JSON file you host (for example from `vid2context get <url> --format json`). The host must allow CORS.',
    group: 'source',
  },
  {
    name: 'api',
    label: 'API server',
    type: 'url',
    default: '',
    help: 'Base URL of another vid2context server, for example your own deployment. Empty means the server that serves the widget.',
    group: 'source',
  },
  {
    name: 'lang',
    label: 'Language',
    type: 'text',
    default: '',
    help: 'BCP-47 code of the transcript to prefer, for example en or pt-BR.',
    group: 'source',
  },
  {
    name: 'mode',
    label: 'Mode',
    type: 'select',
    default: 'auto',
    options: EMBED_MODES,
    help: 'auto: captions first, then speech-to-text. captions, stt and video force one path.',
    group: 'source',
  },
  {
    name: 'view',
    label: 'View',
    type: 'select',
    default: 'transcript',
    options: EMBED_VIEWS,
    help: 'transcript: searchable timed transcript. chapters: the chapter list. quote: the lines between start and end. card: title, thumbnail and chapters. input: a link box that opens the vid2context app.',
    group: 'look',
  },
  {
    name: 'theme',
    label: 'Theme',
    type: 'select',
    default: 'auto',
    options: EMBED_THEMES,
    help: 'auto follows the reader’s system setting.',
    group: 'look',
  },
  {
    name: 'accent',
    label: 'Accent color',
    type: 'color',
    default: '',
    help: 'Hex color for highlights and buttons, without the #, for example 3b82f6.',
    group: 'look',
  },
  {
    name: 'compact',
    label: 'Compact',
    type: 'flag',
    default: '0',
    help: 'Tighter spacing and smaller text.',
    group: 'look',
  },
  {
    name: 'header',
    label: 'Header',
    type: 'flag',
    default: '1',
    help: 'Show the title, channel and length.',
    group: 'show',
  },
  {
    name: 'player',
    label: 'Video player',
    type: 'flag',
    default: '0',
    help: 'YouTube only: show the video (youtube-nocookie.com) above the transcript, keep the current line in sync and seek on click. Off by default because it loads YouTube.',
    group: 'show',
  },
  {
    name: 'timestamps',
    label: 'Timestamps',
    type: 'flag',
    default: '1',
    help: 'Show a timestamp before each line.',
    group: 'show',
  },
  {
    name: 'search',
    label: 'Search box',
    type: 'flag',
    default: '1',
    help: 'Filter the transcript as the reader types.',
    group: 'show',
  },
  {
    name: 'tools',
    label: 'Copy and download',
    type: 'flag',
    default: '1',
    help: 'Copy the transcript, download it as text, SRT or JSON, or open the video in the vid2context app.',
    group: 'show',
  },
  {
    name: 'branding',
    label: 'Credit line',
    type: 'flag',
    default: '1',
    help: 'A small "Context by vid2context" link in the footer.',
    group: 'show',
  },
  {
    name: 'start',
    label: 'Start (seconds)',
    type: 'seconds',
    default: '',
    help: 'Show only lines from this time on. Also the start of a quote. Accepts 75, 1:15 or 1m15s.',
    group: 'range',
  },
  {
    name: 'end',
    label: 'End (seconds)',
    type: 'seconds',
    default: '',
    help: 'Show only lines up to this time.',
    group: 'range',
  },
];

export type EmbedParams = Record<string, string>;

/** What the embed builder shows first: a recorded sample, so the preview needs no API call. */
export const BUILDER_START: EmbedParams = { ...Object.fromEntries(EMBED_PARAMS.map((p) => [p.name, p.default])), sample: 'zoo' };

const PARAM_BY_NAME = new Map(EMBED_PARAMS.map((p) => [p.name, p]));

export function embedDefaults(): EmbedParams {
  return Object.fromEntries(EMBED_PARAMS.map((p) => [p.name, p.default]));
}

/** 75, "75", "1:15", "01:01:15", "1m15s", "1h2m3s" to seconds; undefined when it is none of those. */
export function parseSeconds(raw: string | null | undefined): number | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const clock = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const units = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  return undefined;
}

/** 75 to "1:15", 3675 to "1:01:15". */
export function clock(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * Check one value. Returns the cleaned value, or an error message. Values are
 * strict because they end up in CSS (accent) and in fetch URLs (api, src).
 */
export function checkParam(name: string, raw: string): { value: string } | { error: string } {
  const p = PARAM_BY_NAME.get(name);
  if (!p) return { error: `Unknown parameter "${name}".` };
  const v = raw.trim();
  if (v === '') return { value: '' };
  switch (p.type) {
    case 'url':
      return isHttpUrl(v) ? { value: v } : { error: `${p.label} must be an http or https URL.` };
    case 'select':
    case 'sample':
      return p.options?.includes(v) ? { value: v } : { error: `${p.label} must be one of: ${p.options?.join(', ')}.` };
    case 'flag':
      if (['1', 'true', 'yes', 'on'].includes(v)) return { value: '1' };
      if (['0', 'false', 'no', 'off'].includes(v)) return { value: '0' };
      return { error: `${p.label} must be 1 or 0.` };
    case 'color': {
      const hex = v.replace(/^#/, '');
      return /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex) ? { value: hex.toLowerCase() } : { error: `${p.label} must be a hex color like 3b82f6.` };
    }
    case 'seconds': {
      const n = parseSeconds(v);
      return n === undefined ? { error: `${p.label} must be seconds, m:ss or 1m15s.` } : { value: String(n) };
    }
    case 'text':
      return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v) ? { value: v } : { error: `${p.label} must be a language code like en or pt-BR.` };
  }
}

export interface ParsedEmbed {
  params: EmbedParams;
  errors: string[];
}

/** Read the widget's query string: unknown keys are ignored, bad values fall back to the default with an error. */
export function parseEmbedParams(search: string | URLSearchParams): ParsedEmbed {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const params = embedDefaults();
  const errors: string[] = [];
  for (const p of EMBED_PARAMS) {
    const raw = q.get(p.name);
    if (raw === null) continue;
    const r = checkParam(p.name, raw);
    if ('error' in r) errors.push(r.error);
    else params[p.name] = r.value;
  }
  if (params.start && params.end && Number(params.end) <= Number(params.start)) {
    errors.push('End must be after start.');
    params.end = '';
  }
  return { params, errors };
}

/** Only the values that differ from the defaults, in the order of EMBED_PARAMS. */
export function changedParams(params: EmbedParams): [string, string][] {
  return EMBED_PARAMS.filter((p) => (params[p.name] ?? p.default) !== p.default).map((p) => [p.name, params[p.name] ?? '']);
}

/** The widget URL for these params on the given origin (no trailing slash), for example https://vid2context.com. */
export function embedUrl(origin: string, params: EmbedParams): string {
  const q = new URLSearchParams(changedParams(params)).toString();
  return `${origin}/embed/${q ? `?${q}` : ''}`;
}

/** A height that fits the view, so a first paste looks right before auto-resize kicks in. */
export function suggestedHeight(params: EmbedParams): number {
  const base = { transcript: 480, chapters: 360, quote: 240, card: 420, input: 120 }[params.view as EmbedView] ?? 480;
  return base + (params.player === '1' && params.view !== 'input' ? 300 : 0);
}

// ------------------------------------------------------------------ snippets

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function embedTitle(params: EmbedParams): string {
  if (params.view === 'input') return 'Get video context with vid2context';
  return `Video ${params.view === 'card' ? 'summary' : params.view} by vid2context`;
}

export function iframeSnippet(origin: string, params: EmbedParams, height = suggestedHeight(params)): string {
  return [
    '<iframe',
    `  src="${attr(embedUrl(origin, params))}"`,
    `  title="${attr(embedTitle(params))}"`,
    `  width="100%" height="${height}"`,
    '  style="border:0;border-radius:12px;max-width:720px"',
    `  loading="lazy"${params.player === '1' ? '\n  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"' : ''}`,
    '></iframe>',
  ].join('\n');
}

export function componentSnippet(origin: string, params: EmbedParams): string {
  const attrs = changedParams(params).map(([k, v]) => `  ${k}="${attr(v)}"`);
  return [
    `<script src="${origin}/embed.js" async></script>`,
    '',
    attrs.length ? `<vid2context-embed\n${attrs.join('\n')}\n></vid2context-embed>` : '<vid2context-embed></vid2context-embed>',
  ].join('\n');
}

export function javascriptSnippet(origin: string, params: EmbedParams): string {
  const entries = changedParams(params).map(([k, v]) => `  ${/^[a-z]+$/.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)},`);
  return [
    `<div id="video-context"></div>`,
    `<script src="${origin}/embed.js"></script>`,
    '<script>',
    `  const widget = Vid2Context.embed('#video-context', {`,
    ...entries.map((e) => `  ${e}`),
    '  });',
    `  widget.addEventListener('vid2context:loaded', (e) => console.log(e.detail.title));`,
    `  widget.addEventListener('vid2context:segment', (e) => console.log(e.detail.startSec, e.detail.text));`,
    '</script>',
  ].join('\n');
}

export function reactSnippet(origin: string, params: EmbedParams): string {
  const src = embedUrl(origin, params);
  return [
    'export function VideoContext() {',
    '  return (',
    '    <iframe',
    `      src=${JSON.stringify(src)}`,
    `      title=${JSON.stringify(embedTitle(params))}`,
    `      width="100%"`,
    `      height={${suggestedHeight(params)}}`,
    `      style={{ border: 0, borderRadius: 12, maxWidth: 720 }}`,
    `      loading="lazy"`,
    '    />',
    '  );',
    '}',
  ].join('\n');
}

export function markdownSnippet(origin: string, params: EmbedParams): string {
  return `[Transcript and chapters on vid2context](${embedUrl(origin, params)})`;
}

export const SNIPPETS: { id: string; label: string; lang: string; build: (origin: string, p: EmbedParams) => string }[] = [
  { id: 'iframe', label: 'HTML iframe', lang: 'html', build: iframeSnippet },
  { id: 'component', label: 'Web component', lang: 'html', build: componentSnippet },
  { id: 'javascript', label: 'JavaScript', lang: 'html', build: javascriptSnippet },
  { id: 'react', label: 'React', lang: 'tsx', build: reactSnippet },
  { id: 'link', label: 'Link', lang: 'markdown', build: markdownSnippet },
];

// ------------------------------------------------------------------ messages

/** Every message the widget posts to its parent carries this source. */
export const MESSAGE_SOURCE = 'vid2context';

export interface WidgetEvent {
  type: 'ready' | 'loaded' | 'resize' | 'segment' | 'seek' | 'search' | 'error';
  description: string;
  detail: string;
}

export const WIDGET_EVENTS: WidgetEvent[] = [
  { type: 'ready', description: 'The widget started and is loading its context.', detail: '`{ version }`' },
  {
    type: 'loaded',
    description: 'The context is shown.',
    detail: '`{ title, url, durationSec, segments, chapters, language, origin }`',
  },
  { type: 'resize', description: 'The content height changed. The loader uses it to size the iframe.', detail: '`{ height }`' },
  { type: 'segment', description: 'The reader clicked a line or a chapter.', detail: '`{ startSec, endSec, text }`' },
  {
    type: 'seek',
    description: 'With the player on, playback reached a new line.',
    detail: '`{ sec, index }`',
  },
  { type: 'search', description: 'The search box changed.', detail: '`{ query, matches }`' },
  { type: 'error', description: 'The context could not be loaded or a parameter was wrong.', detail: '`{ code, message, hint }`' },
];

export interface WidgetCommand {
  type: 'seek' | 'search' | 'theme' | 'load';
  description: string;
  payload: string;
}

export const WIDGET_COMMANDS: WidgetCommand[] = [
  { type: 'seek', description: 'Scroll to the line at this time (and seek the player when it is on).', payload: '`{ sec }`' },
  { type: 'search', description: 'Set the search box.', payload: '`{ query }`' },
  { type: 'theme', description: 'Switch theme without reloading.', payload: '`{ theme: "auto" | "light" | "dark" }`' },
  { type: 'load', description: 'Load another video, sample or JSON file.', payload: '`{ url }`, `{ sample }` or `{ src }`' },
];
