/**
 * Build-time markup for the embed builder (`widget embed-builder`) and the
 * Markdown tables the embed docs use. The builder works from this markup:
 * src/scripts/embed-builder.ts reads the form, updates the live preview and
 * rewrites the snippets as the reader changes options.
 */
import { SITE_URL } from '../data/site.ts';
import {
  BUILDER_START,
  EMBED_PARAMS,
  type EmbedParams,
  embedDefaults,
  iframeSnippet,
  EMBED_SAMPLES,
  type EmbedParam,
  embedUrl,
  SNIPPETS,
  suggestedHeight,
  WIDGET_COMMANDS,
  WIDGET_EVENTS,
} from './embed.ts';
import type { Widget } from './widgets.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');


const GROUPS: { id: EmbedParam['group']; label: string }[] = [
  { id: 'source', label: 'Video' },
  { id: 'look', label: 'Look' },
  { id: 'show', label: 'Show' },
  { id: 'range', label: 'Time range' },
];

function field(p: EmbedParam, value: string): string {
  const id = `eb-${p.name}`;
  const help = `<p class="eb-help" id="${id}-help">${esc(p.help.replace(/`/g, ''))}</p>`;
  const described = `aria-describedby="${id}-help"`;
  if (p.type === 'flag') {
    return `<div class="eb-field eb-check"><input type="checkbox" id="${id}" name="${p.name}" ${value === '1' ? 'checked' : ''} ${described} /><label for="${id}">${esc(p.label)}</label>${help}</div>`;
  }
  if (p.type === 'select' || p.type === 'sample') {
    const opts = [...(p.type === 'sample' ? [''] : []), ...(p.options ?? [])]
      .map((o) => {
        const label = p.type === 'sample' ? (EMBED_SAMPLES.find((s) => s.id === o)?.label ?? 'None') : o;
        return `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(label)}</option>`;
      })
      .join('');
    return `<div class="eb-field"><label for="${id}">${esc(p.label)}</label><select id="${id}" name="${p.name}" ${described}>${opts}</select>${help}</div>`;
  }
  const type = p.type === 'url' ? 'url' : 'text';
  const placeholder = { url: p.name === 'url' ? 'https://www.youtube.com/watch?v=...' : 'https://...', color: '3b82f6', seconds: '1:15', text: 'en' }[
    p.type as 'url' | 'color' | 'seconds' | 'text'
  ];
  const extra = p.type === 'color' ? '<input type="color" class="eb-swatch" aria-label="Pick the accent color" value="#3b82f6" />' : '';
  return `<div class="eb-field"><label for="${id}">${esc(p.label)}</label><div class="eb-inline"><input type="${type}" id="${id}" name="${p.name}" value="${esc(value)}" placeholder="${esc(placeholder ?? '')}" spellcheck="false" autocomplete="off" ${described} />${extra}</div>${help}</div>`;
}

function builderHtml(): string {
  const start = BUILDER_START;
  const src = embedUrl('', start);
  const groups = GROUPS.map((g) => {
    const fields = EMBED_PARAMS.filter((p) => p.group === g.id)
      .map((p) => field(p, start[p.name] ?? ''))
      .join('');
    return `<fieldset class="eb-group" data-group="${g.id}"><legend>${g.label}</legend>${fields}</fieldset>`;
  }).join('');
  const size = `<fieldset class="eb-group" data-group="size"><legend>Size</legend>
<div class="eb-field"><label for="eb-height">Height in pixels</label><input type="text" inputmode="numeric" id="eb-height" name="height" value="" placeholder="auto (${suggestedHeight(start)})" aria-describedby="eb-height-help" /><p class="eb-help" id="eb-height-help">Empty: the snippet uses a height that fits the view, and the web component resizes to its content.</p></div>
</fieldset>`;
  const tabs = SNIPPETS.map(
    (s, n) =>
      `<button type="button" role="tab" id="eb-tab-${s.id}" aria-controls="eb-panel-${s.id}" aria-selected="${n === 0}" tabindex="${n === 0 ? 0 : -1}" data-snippet="${s.id}">${esc(s.label)}</button>`,
  ).join('');
  const panels = SNIPPETS.map(
    (s, n) =>
      `<div class="code eb-code" role="tabpanel" id="eb-panel-${s.id}" aria-labelledby="eb-tab-${s.id}"${n === 0 ? '' : ' hidden'}><div class="code-bar"><span class="code-label">${esc(s.label)}</span><button type="button" class="copy-btn" data-eb-copy="${s.id}">Copy</button></div><pre tabindex="0"><code data-eb-out="${s.id}">${esc(s.build(SITE_URL, start))}</code></pre></div>`,
  ).join('');
  return `<div class="eb" data-widget="embed-builder" data-site="${esc(SITE_URL)}">
<form class="eb-form" novalidate aria-label="Embed options">
<div class="eb-presets" role="group" aria-label="Presets">
<span>Start from</span>
<button type="button" class="btn" data-preset="transcript">Transcript</button>
<button type="button" class="btn" data-preset="player">With player</button>
<button type="button" class="btn" data-preset="chapters">Chapters</button>
<button type="button" class="btn" data-preset="quote">Quote</button>
<button type="button" class="btn" data-preset="card">Card</button>
<button type="button" class="btn" data-preset="input">Link box</button>
</div>
${groups}${size}
<p class="eb-error" role="alert" data-eb-error hidden></p>
<div class="eb-actions"><button type="button" class="btn" data-eb-reset>Reset</button><button type="button" class="btn" data-eb-share>Copy link to this setup</button></div>
</form>
<section class="eb-preview" aria-label="Live preview">
<div class="eb-preview-head"><h3>Live preview</h3><a class="eb-open" data-eb-open href="${esc(src)}" target="_blank" rel="noopener">Open the widget alone</a></div>
<div class="eb-frame-wrap"><iframe class="eb-frame" data-eb-frame src="${esc(src)}" title="Live preview of the embed" height="${suggestedHeight(start)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write"></iframe></div>
<p class="eb-url"><span>Widget URL</span><code data-eb-url>${esc(embedUrl(SITE_URL, start))}</code></p>
<div class="eb-drive">
<h3>Drive it from the page</h3>
<p class="eb-help">These buttons send the same postMessage commands your page can send.</p>
<div class="eb-drive-row"><label for="eb-cmd-seek">Seek to</label><input id="eb-cmd-seek" type="text" value="0:05" spellcheck="false" /><button type="button" class="btn" data-eb-cmd="seek">Send seek</button></div>
<div class="eb-drive-row"><label for="eb-cmd-search">Search</label><input id="eb-cmd-search" type="text" value="elephants" spellcheck="false" /><button type="button" class="btn" data-eb-cmd="search">Send search</button></div>
<div class="eb-drive-row"><span>Theme</span><button type="button" class="btn" data-eb-cmd="theme" data-theme-value="light">Light</button><button type="button" class="btn" data-eb-cmd="theme" data-theme-value="dark">Dark</button><button type="button" class="btn" data-eb-cmd="theme" data-theme-value="auto">Auto</button></div>
</div>
<div class="eb-log-wrap"><div class="eb-log-head"><h3>Events from the widget</h3><button type="button" class="btn" data-eb-clear>Clear</button></div><ol class="eb-log" data-eb-log aria-live="polite" aria-label="Events from the widget"></ol></div>
</section>
<section class="eb-snippets" aria-label="Embed code">
<h3>Embed code</h3>
<div class="eb-tabs" role="tablist" aria-label="Embed code format">${tabs}</div>
${panels}
</section>
</div>`;
}

export const embedBuilderWidget: Widget = {
  html: builderHtml,
  twin: () =>
    [
      'The interactive embed builder runs on the HTML version of this page. The snippet it starts with:',
      '',
      '```html',
      SNIPPETS[0]?.build(SITE_URL, BUILDER_START) ?? '',
      '```',
    ].join('\n'),
};

// ------------------------------------------------------------------ docs tables (tokens)

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function paramsTable(): string {
  const rows = EMBED_PARAMS.map((p) => {
    const def = p.type === 'flag' ? (p.default === '1' ? 'on (1)' : 'off (0)') : p.default ? `\`${p.default}\`` : 'none';
    const values = p.options ? p.options.map((o) => `\`${o}\``).join(', ') : { url: 'URL', text: 'language code', flag: '1 or 0', seconds: 'seconds, m:ss or 1m15s', color: 'hex', sample: '', select: '' }[p.type];
    return `| \`${p.name}\` | ${cell(values)} | ${def} | ${cell(p.help)} |`;
  });
  return ['| Parameter | Values | Default | What it does |', '|---|---|---|---|', ...rows].join('\n');
}

export function eventsTable(): string {
  const rows = WIDGET_EVENTS.map((e) => `| \`${e.type}\` | \`vid2context:${e.type}\` | ${cell(e.detail)} | ${cell(e.description)} |`);
  return ['| Message `type` | DOM event | Fields | When |', '|---|---|---|---|', ...rows].join('\n');
}

export function commandsTable(): string {
  const rows = WIDGET_COMMANDS.map((c) => `| \`${c.type}\` | ${cell(c.payload)} | ${cell(c.description)} |`);
  return ['| `type` | Fields | What it does |', '|---|---|---|', ...rows].join('\n');
}

export function samplesList(): string {
  return EMBED_SAMPLES.map((s) => `- \`${s.id}\`: [${s.label}](${s.url})`).join('\n');
}

// ------------------------------------------------------------------ gallery and component demo

const GALLERY: { title: string; note: string; params: Partial<EmbedParams> }[] = [
  { title: 'Transcript', note: 'Searchable, with chapters as a second tab. Click a line to get a segment event.', params: { sample: 'zoo' } },
  { title: 'Chapters', note: 'Only the chapter list, each one a link to that moment.', params: { sample: 'zoo', view: 'chapters', tools: '0' } },
  { title: 'Quote', note: 'The lines between start and end, with a timed citation.', params: { sample: 'zoo', view: 'quote', start: '5', end: '13' } },
  { title: 'Card', note: 'Title, thumbnail and chapters, with a button to the full transcript. Loads the thumbnail from YouTube.', params: { sample: 'zoo', view: 'card' } },
  { title: 'Link box', note: 'A small form that opens any video in the vid2context app. Needs no video.', params: { view: 'input' } },
];

function codeBlock(label: string, text: string): string {
  return `<div class="code"><div class="code-bar"><span class="code-label">${esc(label)}</span><button type="button" class="copy-btn" data-copy-btn>Copy</button></div><pre tabindex="0"><code>${esc(text)}</code></pre></div>`;
}

function galleryHtml(): string {
  const items = GALLERY.map((g) => {
    const params = { ...embedDefaults(), ...g.params } as EmbedParams;
    const h = suggestedHeight(params);
    return `<figure class="eg-item"><figcaption><strong>${esc(g.title)}</strong> ${esc(g.note)}</figcaption><iframe class="eb-frame" data-eb-auto="${esc(params.view ?? 'transcript')}" src="${esc(embedUrl('', params))}" title="${esc(`${g.title} embed example`)}" height="${h}" loading="lazy"></iframe>${codeBlock('HTML', iframeSnippet(SITE_URL, params))}</figure>`;
  }).join('');
  return `<div class="eg" data-widget="embed-gallery">${items}</div>`;
}

function galleryTwin(): string {
  return GALLERY.map((g) => {
    const params = { ...embedDefaults(), ...g.params } as EmbedParams;
    return `### ${g.title}\n\n${g.note}\n\n\`\`\`html\n${iframeSnippet(SITE_URL, params)}\n\`\`\``;
  }).join('\n\n');
}

export const embedGalleryWidget: Widget = { html: galleryHtml, twin: galleryTwin };

const COMPONENT_DEMO = `<script src="${SITE_URL}/embed.js" async></script>

<vid2context-embed id="demo" sample="gwagon" max-height="420"></vid2context-embed>

<script>
  const demo = document.getElementById('demo');
  demo.addEventListener('vid2context:loaded', (e) => console.log(e.detail.title, e.detail.segments));
  demo.addEventListener('vid2context:segment', (e) => console.log(e.detail.startSec, e.detail.text));
  demo.seek('2:30');          // scroll to 2:30
  demo.search('engine');      // filter the transcript
  demo.setAttribute('theme', 'light');
</script>`;

function componentDemoHtml(): string {
  return `<div class="ec" data-widget="embed-component">
<div class="ec-controls" role="group" aria-label="Call the element's methods">
<button type="button" class="btn" data-ec="seek" data-arg="150">seek('2:30')</button>
<button type="button" class="btn" data-ec="search" data-arg="engine">search('engine')</button>
<button type="button" class="btn" data-ec="search" data-arg="">search('')</button>
<button type="button" class="btn" data-ec="theme" data-arg="light">theme="light"</button>
<button type="button" class="btn" data-ec="theme" data-arg="dark">theme="dark"</button>
<button type="button" class="btn" data-ec="load" data-arg="zoo">load({ sample: 'zoo' })</button>
<button type="button" class="btn" data-ec="load" data-arg="gwagon">load({ sample: 'gwagon' })</button>
</div>
<div class="ec-stage" data-ec-stage><p class="eb-help">The element appears here once /embed.js loads.</p></div>
<div class="eb-log-wrap"><div class="eb-log-head"><h3>DOM events</h3><button type="button" class="btn" data-ec-clear>Clear</button></div><ol class="eb-log" data-ec-log aria-live="polite" aria-label="DOM events from the element"></ol></div>
${codeBlock('HTML', COMPONENT_DEMO)}
</div>`;
}

export const embedComponentWidget: Widget = {
  html: componentDemoHtml,
  twin: () => `\`\`\`html\n${COMPONENT_DEMO}\n\`\`\``,
};
