/**
 * Build-time rendering of runnable examples. A fenced block whose info string
 * is `run <id>` becomes a form with the request's fields, the curl, fetch,
 * Python, CLI and MCP snippets, and the response recorded from a real server
 * (site/test/fixtures/runnables/<id>.json). The browser script in
 * src/scripts/runnables.ts makes it live. The Markdown twin gets the curl
 * command and the recorded response instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { runnable, runnables } from '../data/runnables.ts';
import { data, SITE_URL } from '../data/site.ts';
import { repoPath } from './paths.ts';
import {
  buildRequest,
  clipOutput,
  curlSnippet,
  defaults,
  escapeHtml as esc,
  type Field,
  formatDuration,
  highlightCode,
  presentRecording,
  type Recording,
  type RunnableSpec,
  STATUS_TEXT,
  type Snippet,
  type SnippetOptions,
  snippets,
} from './runnable.ts';

export const CLI_PREFIX = data.npm.cliPublished ? `npx -y ${data.npm.cliPackage}` : 'npm run -s cli --';
export const FIXTURE_DIR = 'site/test/fixtures/runnables';
const OPTS: SnippetOptions = { base: SITE_URL, auth: false, cliPrefix: CLI_PREFIX };

/** Lines and characters of a recorded response shown on the page and in the twin. */
const PAGE_LINES = 80;
const PAGE_CHARS = 12_000;
const TWIN_LINES = 40;
const TWIN_CHARS = 4_000;

/** `run <id>` in a fence's info string. */
export const RUN_FENCE = /^run\s+([a-z0-9-]+)\s*$/;

export function recording(id: string): Recording {
  const file = repoPath(FIXTURE_DIR, `${id}.json`);
  if (!existsSync(file)) {
    throw new Error(`No recorded response for runnable "${id}". Start a server and run: npm --prefix site run record -- ${id}`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Recording;
}

const statusLine = (rec: Recording) => `${rec.status} ${STATUS_TEXT[rec.status] ?? ''}`.trim();

/** JSON for a `<script type="application/json">`: nothing in it can close the tag. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function fieldHtml(spec: RunnableSpec, f: Field, uid: string, sourceTitle: string | undefined): string {
  const id = `${uid}-f-${f.name}`;
  const helpId = `${id}-help`;
  const helps: string[] = [];
  if (f.help) helps.push(esc(f.help));
  if (f.from && sourceTitle) helps.push(`Filled in when you run "${esc(sourceTitle)}" above.`);
  const describedBy = helps.length ? ` aria-describedby="${helpId}"` : '';
  const help = helps.length ? `<small id="${helpId}" class="rx-help">${helps.join(' ')}</small>` : '';
  const value = esc(f.default ?? '');
  const name = `name="${esc(f.name)}"`;
  let control: string;
  switch (f.type) {
    case 'checkbox':
      return `<label class="rx-field rx-check" for="${id}"><input id="${id}" type="checkbox" ${name}${f.default === 'true' ? ' checked' : ''}${describedBy}> <span>${esc(f.label)}</span>${help}</label>`;
    case 'select':
      control = `<select id="${id}" ${name}${describedBy}>${(f.options ?? [])
        .map((o) => `<option value="${esc(o)}"${o === (f.default ?? '') ? ' selected' : ''}>${o === '' ? 'any' : esc(o)}</option>`)
        .join('')}</select>`;
      break;
    case 'list':
    case 'json': {
      const rows = Math.min(14, Math.max(2, (f.default ?? '').split('\n').length));
      control = `<textarea id="${id}" ${name} rows="${rows}" spellcheck="false"${describedBy}>${value}</textarea>`;
      break;
    }
    case 'number':
      control = `<input id="${id}" type="number" ${name} value="${value}" inputmode="numeric"${describedBy}>`;
      break;
    case 'file': {
      const sample = spec.sample;
      return `<div class="rx-field rx-file"><label for="${id}">${esc(f.label)}</label><div class="rx-file-row"><input id="${id}" type="file" ${name} accept="audio/*,video/*"${describedBy}>${
        sample ? `<button type="button" class="chip" data-rx-sample>${esc(sample.label)}</button>` : ''
      }</div><small class="rx-help" data-rx-file-name>${sample ? `Sending: ${esc(sample.name)} (sample)` : 'No file chosen'}</small></div>`;
    }
    default:
      control = `<input id="${id}" type="text" ${name} value="${value}" spellcheck="false" autocomplete="off"${f.type === 'url' ? ' inputmode="url"' : ''}${describedBy}>`;
  }
  const wide = f.type === 'url' || f.type === 'list' || f.type === 'json' || (f.type === 'text' && (f.default ?? '').length > 24);
  return `<div class="rx-field${wide ? ' rx-wide' : ''}"><label for="${id}">${esc(f.label)}</label>${control}${help}</div>`;
}

const SLOTS: Snippet['id'][] = ['curl', 'fetch', 'python', 'cli', 'mcp'];
const SLOT_LABEL: Record<Snippet['id'], string> = {
  curl: 'curl',
  fetch: 'JavaScript',
  python: 'Python',
  cli: 'CLI',
  mcp: 'MCP tool call',
};
const SLOT_LANG: Record<Snippet['id'], string> = { curl: 'bash', fetch: 'js', python: 'python', cli: 'bash', mcp: 'json' };

/** One renderer per page, so a spec used twice gets distinct element ids. */
export function createRunnableRenderer(): (id: string) => string {
  const seen = new Map<string, number>();
  return (id: string) => {
    const spec = runnable(id);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return renderBlock(spec, n === 1 ? `run-${id}` : `run-${id}-${n}`);
  };
}

function renderBlock(spec: RunnableSpec, uid: string): string {
  const rec = recording(spec.id);
  const values = defaults(spec);
  const list = snippets(spec, values, OPTS);
  const byId = new Map(list.map((s) => [s.id, s]));
  // A field filled from an earlier block names that block in its help text.
  const fromName = spec.fields.find((f) => f.from)?.from;
  const fromTitle = fromName ? runnables.find((r) => r.provides?.name === fromName)?.title : undefined;

  const tabs = SLOTS.map((slot, n) => {
    const s = byId.get(slot);
    return `<button type="button" role="tab" id="${uid}-tab-${slot}" aria-controls="${uid}-panel-${slot}" aria-selected="${n === 0}" tabindex="${n === 0 ? 0 : -1}" data-rx-tab="${slot}"${s ? '' : ' hidden'}>${SLOT_LABEL[slot]}</button>`;
  }).join('');
  const panels = SLOTS.map((slot, n) => {
    const s = byId.get(slot);
    return `<div class="code rx-panel" role="tabpanel" id="${uid}-panel-${slot}" aria-labelledby="${uid}-tab-${slot}" data-rx-panel="${slot}"${n === 0 ? '' : ' hidden'}><div class="code-bar"><span class="code-label">${SLOT_LANG[slot]}</span><button type="button" class="copy-btn" data-copy-btn>Copy</button></div><pre tabindex="0"><code>${s ? highlightCode(s.code, s.lang) : ''}</code></pre></div>`;
  }).join('');

  const shown = presentRecording(rec);
  const clip = clipOutput(shown.text, PAGE_LINES, PAGE_CHARS);
  const headers = Object.entries(rec.headers)
    .map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`)
    .join('');
  const recordedLabel = `Recorded response: ${statusLine(rec)}, ${formatDuration(rec.ms)}, ${rec.recordedAt}`;
  const out = `<div class="rx-out" data-rx-out><div class="code"><div class="code-bar"><span class="code-label rx-status" data-rx-status>${esc(recordedLabel)}</span><span class="rx-out-actions"><button type="button" class="copy-btn" data-rx-toggle hidden>Show recorded</button><a class="copy-btn" data-rx-download hidden>Download</a><button type="button" class="copy-btn" data-copy-btn>Copy</button></span></div><div class="rx-meta" data-rx-meta>${headers}</div><pre tabindex="0" data-rx-body class="${rec.status >= 400 ? 'rx-error' : ''}"><code>${highlightCode(clip.text, shown.lang)}</code></pre></div><p class="rx-clip" data-rx-clip${clip.clipped > 0 ? '' : ' hidden'}>${clip.clipped > 0 ? `${clip.clipped} more lines not shown. Run it to see the whole response.` : ''}</p></div>`;

  const fields = spec.fields.map((f) => fieldHtml(spec, f, uid, f.from ? fromTitle : undefined)).join('');
  return `<section class="rx" id="${uid}" data-rx aria-labelledby="${uid}-title">
<script type="application/json" data-rx-spec>${scriptJson(spec)}</script>
<header class="rx-head"><span class="rx-method rx-method-${spec.method.toLowerCase()}">${spec.method}</span><code class="rx-path">${esc(spec.path)}</code><a class="rx-title" id="${uid}-title" href="#${uid}">${esc(spec.title)}</a></header>
${spec.note ? `<p class="rx-note">${esc(spec.note)}</p>` : ''}
<form class="rx-form" novalidate>${fields ? `<div class="rx-fields">${fields}</div>` : ''}<p class="rx-input-error" data-rx-input-error role="alert" hidden></p><div class="rx-actions"><button type="submit" class="btn btn-primary rx-run" data-rx-run disabled title="Loading">Run</button><button type="button" class="btn rx-reset" data-rx-reset>Reset</button><span class="rx-server"><label for="${uid}-server">Server</label><select id="${uid}-server" data-rx-server disabled><option value="site">This site</option><option value="local">Local server (127.0.0.1:8787)</option><option value="custom">Custom URL</option></select><button type="button" class="rx-gear" data-rx-settings aria-label="Server URL and API key" title="Server URL and API key" disabled><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg></button><span class="rx-health" data-rx-health></span></span></div></form>
<div class="rx-code"><div class="rx-tabs" role="tablist" aria-label="Code for this request">${tabs}</div>${panels}</div>
${out}
</section>`;
}

/** The twin's version of a block: the request as curl and the recorded response. */
export function runnableTwin(id: string): string {
  const spec = runnable(id);
  const rec = recording(id);
  const req = buildRequest(spec, defaults(spec));
  const shown = presentRecording(rec);
  const clip = clipOutput(shown.text, TWIN_LINES, TWIN_CHARS);
  const more = clip.clipped > 0 ? `\n\n(${clip.clipped} more lines; run the request to see them.)` : '';
  const lang = shown.lang === 'json' ? 'json' : 'text';
  // A fence longer than any backtick run in the output, so the output cannot close it.
  const longest = Math.max(0, ...[...clip.text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [
    `**${spec.title}** (\`${spec.method} ${spec.path}\`)${spec.note ? `: ${spec.note}` : ''}`,
    '',
    '```bash',
    curlSnippet(spec, req, OPTS),
    '```',
    '',
    `Response recorded on ${rec.recordedAt} (HTTP ${statusLine(rec)}):`,
    '',
    `${fence}${lang}`,
    clip.text,
    `${fence}${more}`,
  ].join('\n');
}

/** Replace every `run <id>` fence in Markdown with its twin text. */
export function expandRunFencesForTwin(md: string): string {
  return md.replace(/^```run\s+([a-z0-9-]+)\s*\n```\s*$/gm, (_m, id: string) => runnableTwin(id));
}

/** Ids of the `run <id>` fences in Markdown, in order. */
export function runFenceIds(md: string): string[] {
  return [...md.matchAll(/^```run\s+([a-z0-9-]+)\s*$/gm)].map((m) => m[1] as string);
}
