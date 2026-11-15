/**
 * Build-time markup for the library playground (`widget playground`). The page
 * reads well before any script runs: the form, the code the default run executes
 * and its real output (the smallest fixture as SRT) are rendered here. The browser
 * side is src/scripts/playground.ts, with core itself in src/scripts/playground-worker.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { type Formatter, formatters, render, type VideoContext } from '@vid2context/core';
import {
  contextSummary,
  defaultState,
  type FormatInfo,
  type FormatOptionKey,
  OPS,
  opCode,
  STARTERS,
} from '../scripts/playground-state.ts';
import { repoPath } from './paths.ts';
import type { Widget } from './widgets.ts';

export const FIXTURE_DIR = 'tests/fixtures/contexts';

/** Formats that lay out caption cues (they read maxLineChars and maxLines through buildCues in core's cues.ts). */
const CUE_FORMATS = new Set(['srt', 'vtt', 'ass', 'ttml', 'sbv', 'lrc']);

/**
 * The FormatOptions each formatter reads. offsetSec and secondary come from the
 * formatter's own `timed` and `bilingual` flags; the rest is read from the
 * formatter sources (test/playground.test.ts checks each against core's output).
 */
export function formatOptionsOf(f: Formatter): FormatOptionKey[] {
  const out: FormatOptionKey[] = [];
  if (f.id === 'text') out.push('timestamps');
  if (f.timed) out.push('offsetSec');
  if (CUE_FORMATS.has(f.id)) out.push('maxLineChars', 'maxLines');
  if (f.id === 'pack') out.push('maxTokens');
  if (f.id === 'markdown' || f.id === 'pack') out.push('linkTimestamps', 'includeComments', 'includeVisual');
  if (f.bilingual) out.push('secondary');
  return out;
}

export function formatInfos(): FormatInfo[] {
  return Object.values(formatters).map((f) => ({
    id: f.id,
    description: f.description,
    extension: f.extension,
    mimeType: f.mimeType,
    options: formatOptionsOf(f),
    ...(f.timed ? { timed: f.timed } : {}),
  }));
}

export interface FixtureInfo {
  id: string;
  title: string;
  summary: string;
  segments: number;
}

export function loadFixture(id: string): VideoContext {
  return JSON.parse(readFileSync(repoPath(FIXTURE_DIR, `${id}.json`), 'utf8')) as VideoContext;
}

/** Every real context in tests/fixtures/contexts, smallest first (the first is the default). */
export function fixtureInfos(): FixtureInfo[] {
  return readdirSync(repoPath(FIXTURE_DIR))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const id = f.slice(0, -'.json'.length);
      const c = loadFixture(id);
      return { id, title: c.metadata.title, summary: contextSummary(c), segments: c.transcript.segments.length };
    })
    .sort((a, b) => a.segments - b.segments || a.id.localeCompare(b.id));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let count = 0;

function html(): string {
  const n = ++count;
  const id = (name: string) => `pg${n}-${name}`;
  const fixtures = fixtureInfos();
  const first = fixtures[0];
  if (!first) throw new Error(`No contexts in ${FIXTURE_DIR}: the playground needs at least one.`);
  const formats = formatInfos();
  const state = defaultState(first.id);
  const run = opCode(state, formats, false);
  const output = render(loadFixture(first.id), state.format);
  const fmt = formats.find((f) => f.id === state.format);

  const field = (name: string, label: string, control: string, help = '', cls = '') =>
    `<div class="pg-field${cls ? ` ${cls}` : ''}" data-pg-opt="${name}"><label for="${id(name)}">${label}</label>${control}${help ? `<p class="pg-help">${help}</p>` : ''}</div>`;
  const input = (name: string, attrs = '') =>
    `<input id="${id(name)}" data-pg-field="${name}" type="text" spellcheck="false" autocomplete="off"${attrs} />`;
  const numberInput = (name: string, value: string, attrs = '') =>
    `<input id="${id(name)}" data-pg-field="${name}" type="number" inputmode="numeric" value="${value}"${attrs} />`;
  const select = (name: string, options: [string, string][], selected: string) =>
    `<select id="${id(name)}" data-pg-field="${name}">${options.map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const check = (name: string, label: string, checked: boolean) =>
    `<div class="pg-field pg-check" data-pg-opt="${name}"><input id="${id(name)}" data-pg-field="${name}" type="checkbox"${checked ? ' checked' : ''} /><label for="${id(name)}">${label}</label></div>`;
  const tri = (name: string, label: string) =>
    field(
      name,
      label,
      select(
        name,
        [
          ['', 'Format default'],
          ['include', 'Include'],
          ['omit', 'Leave out'],
        ],
        '',
      ),
    );
  const outPanel = (kind: string, label: string, body: string, status: string) =>
    `<div class="code pg-out"><div class="code-bar"><span class="code-label pg-status" data-pg-status="${kind}" role="status" aria-live="polite">${esc(status)}</span><span class="pg-out-actions"><button type="button" class="copy-btn" data-pg-copy="${kind}">Copy</button><button type="button" class="copy-btn" data-pg-download="${kind}">Download</button></span></div><pre tabindex="0" data-pg-output="${kind}" aria-label="${label}"><code>${esc(body)}</code></pre></div>`;

  const radios = (
    [
      ['fixture', 'Fixture'],
      ['paste', 'Paste JSON'],
      ['api', 'From the API'],
    ] as const
  )
    .map(
      ([v, l]) =>
        `<label class="pg-seg-item"><input type="radio" name="${id('source')}" value="${v}" data-pg-field="source"${v === 'fixture' ? ' checked' : ''} /><span>${l}</span></label>`,
    )
    .join('');

  const source = `<fieldset class="pg-step"><legend>Context</legend>
<div class="pg-seg">${radios}</div>
<div data-pg-panel="fixture">${field(
    'fixture',
    'Fixture',
    select(
      'fixture',
      fixtures.map((f) => [f.id, `${f.title} (${f.id})`]),
      first.id,
    ),
    `Real <code>VideoContext</code> output from <code>${FIXTURE_DIR}/</code> in the repo.`,
  )}</div>
<div data-pg-panel="paste" hidden>${field('paste', 'VideoContext JSON', `<textarea id="${id('paste')}" data-pg-field="paste" rows="10" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>`, 'The body of <code>GET /api/v1/context</code>, or <code>vid2context &lt;url&gt; --format json</code>. It stays on this page: shared links carry fixtures and API URLs, not pasted JSON.')}<button type="button" class="btn" data-pg-fill>Start from the fixture</button></div>
<div data-pg-panel="api" hidden><div class="pg-fields">${field('url', 'Video URL', input('url', ' inputmode="url" placeholder="https://www.youtube.com/watch?v=jNQXAC9IVRw"'), '', 'pg-wide')}${field('server', 'Server URL (optional)', input('server', ' inputmode="url" placeholder="Empty: this site"'), 'Calls <code>GET /api/v1/context</code>. Your own server needs <code>VID2CONTEXT_CORS_ORIGINS</code> set to this site.', 'pg-wide')}</div><button type="button" class="btn" data-pg-fetch>Fetch</button></div>
<p class="pg-summary" data-pg-summary role="status" aria-live="polite">${esc(first.summary)}</p>
<pre class="pg-error" data-pg-source-error role="alert" hidden></pre>
</fieldset>`;

  const prepare = `<fieldset class="pg-step"><legend>Section and cleanup</legend>
<div class="pg-fields">${field('from', 'From', input('from', ' placeholder="Start"'), 'Seconds, m:ss or h:mm:ss.')}${field('to', 'To', input('to', ' placeholder="End"'))}${field('chapter', 'Chapter', select('chapter', [['', 'Whole video']], ''), 'Sections from <code>transcriptOutline</code>.')}</div>
<div class="pg-fields">${check('clean', 'Clean the transcript first', false)}${field(
    'tags',
    'Sound tags',
    select(
      'tags',
      [
        ['keep', 'Keep'],
        ['remove', 'Remove'],
      ],
      'keep',
    ),
  )}${field(
    'quotes',
    'Quotes',
    select(
      'quotes',
      [
        ['keep', 'Keep'],
        ['straight', 'Straighten'],
      ],
      'keep',
    ),
  )}${check('sentences', 'Rebuild sentences', true)}${check('fillers', 'Remove fillers', false)}</div>
</fieldset>`;

  const formatOptionsHtml = [
    check('timestamps', 'Timestamps', false),
    check('linkTimestamps', 'Link timestamps', true),
    field('offsetSec', 'Offset (seconds)', numberInput('offsetSec', '', ' step="any" inputmode="decimal" placeholder="0"')),
    field('maxLineChars', 'Line length', numberInput('maxLineChars', '', ' min="10" max="200" placeholder="42"')),
    field('maxLines', 'Lines per cue', numberInput('maxLines', '', ' min="1" max="4" placeholder="2"')),
    field('maxTokens', 'Token budget', numberInput('maxTokens', '', ' min="1" placeholder="No limit"')),
    tri('includeComments', 'Comments'),
    tri('includeVisual', 'Visual notes'),
  ].join('');
  const secondary = `<details class="pg-secondary" data-pg-opt="secondary"><summary>Bilingual: add a second transcript</summary>${field('secondary', 'Second transcript (JSON)', `<textarea id="${id('secondary')}" data-pg-field="secondary" rows="6" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>`, 'A <code>Transcript</code> or a whole <code>VideoContext</code> of the same video in another language. Each of its segments goes under the primary segment it overlaps most. Not kept in shared links.')}<pre class="pg-error" data-pg-secondary-error role="alert" hidden></pre></details>`;

  const operation = `<fieldset class="pg-step"><legend>Operation</legend>
<div class="pg-fields">${field(
    'op',
    'Operation',
    select(
      'op',
      OPS.map((o) => [o.id, o.label]),
      state.op,
    ),
    '',
    'pg-wide',
  )}</div>
<div data-pg-group="render"><div class="pg-fields">${field(
    'format',
    'Format',
    select(
      'format',
      formats.map((f) => [f.id, f.id]),
      state.format,
    ),
    `<span data-pg-format-help>${esc(fmt?.description ?? '')}</span>`,
    'pg-wide',
  )}${formatOptionsHtml}</div>${secondary}</div>
<div data-pg-group="chunk" hidden><div class="pg-fields">${field('chunkTokens', 'Tokens per chunk', numberInput('chunkTokens', state.chunkTokens, ' min="1"'))}${field('overlapTokens', 'Overlap (tokens)', numberInput('overlapTokens', state.overlapTokens, ' min="0"'))}${field(
    'by',
    'Split by',
    select(
      'by',
      [
        ['', 'Chapters when there are any'],
        ['chapters', 'Chapters'],
        ['time', 'Time windows'],
        ['tokens', 'Tokens only'],
      ],
      '',
    ),
  )}${field('targetSec', 'Window (seconds)', numberInput('targetSec', '', ' min="1" placeholder="300"'))}</div></div>
<div data-pg-group="agent" hidden><div class="pg-fields">${field('agentTokens', 'Token budget', numberInput('agentTokens', '', ' min="1" placeholder="30000"'))}${check('agentComments', 'Comments', true)}${check('agentVisual', 'Visual notes', true)}</div></div>
<p class="pg-help" data-pg-group="clean" hidden>Uses the cleanup options above.</p>
</fieldset>`;

  const call = `<div class="code pg-call"><div class="code-bar"><span class="code-label">This runs in a worker</span><button type="button" class="copy-btn" data-pg-to-editor>Edit as code</button></div><pre tabindex="0" data-pg-call aria-label="Code for the chosen operation"><code>${esc(run.code)}</code></pre></div>`;

  const editor = `<div class="pg-step pg-editor">
<div class="pg-editor-head"><label for="${id('code')}" class="pg-editor-label">Your code</label>${field('starter', 'Starter', select('starter', [['', 'Choose a starter'], ...STARTERS.map((s): [string, string] => [s.id, s.label])], ''), '', 'pg-inline')}</div>
<p class="pg-help" id="${id('code-help')}">In scope: <code>core</code> (all of <code>@vid2context/core</code>), <code>context</code> (the context above, before section and cleanup) and <code>secondary</code> (the second transcript, or undefined). Return a value; <code>console.log</code> works too. Runs in a Web Worker, stopped after 5 seconds.</p>
<textarea id="${id('code')}" data-pg-code rows="8" spellcheck="false" autocomplete="off" autocapitalize="off" aria-describedby="${id('code-help')}">${esc(state.code)}</textarea>
<div class="pg-actions"><button type="button" class="btn btn-primary" data-pg-run>Run</button><span class="pg-help">or Ctrl+Enter</span><button type="button" class="btn" data-pg-share>Copy link</button><span class="pg-help" data-pg-share-status role="status" aria-live="polite"></span></div>
${outPanel('snippet', 'Result of your code', '', 'Press Run to see the result.')}
</div>`;

  const formatsJson = esc(JSON.stringify(formats));
  return `<div class="pg" data-pg data-pg-formats="${formatsJson}" data-pg-default="${esc(first.id)}">
${source}
${prepare}
${operation}
<div class="pg-step pg-result">${call}${outPanel('op', 'Output', output, `${fmt?.id ?? state.format}: ${output.length.toLocaleString('en-US')} characters`)}</div>
${editor}
</div>`;
}

function twin(): string {
  const fixtures = fixtureInfos();
  const first = fixtures[0];
  const formats = formatInfos();
  if (!first) return 'The playground runs on the HTML version of this page.';
  const run = opCode(defaultState(first.id), formats, false);
  const output = render(loadFixture(first.id), 'srt');
  return [
    'On the HTML version of this page the playground runs `@vid2context/core` in your browser, in a Web Worker.',
    '',
    `- Context: a fixture (${fixtures.map((f) => `\`${f.id}\``).join(', ')}), your own VideoContext JSON, or \`GET /api/v1/context\`.`,
    `- Operations: render to ${formats.map((f) => `\`${f.id}\``).join(', ')} with their options, \`chunkTranscript\`, \`transcriptOutline\`, \`estimateTokens\` for every format, \`agentPrompt\` and \`cleanTranscript\`.`,
    '- Your own code, with `core`, `context` and `secondary` in scope.',
    '',
    `The default run, on ${first.title} (\`${first.id}\`):`,
    '',
    '```js',
    run.code.trimEnd(),
    '```',
    '',
    '```srt',
    output.trimEnd(),
    '```',
  ].join('\n');
}

export const playgroundWidget: Widget = { html, twin };
