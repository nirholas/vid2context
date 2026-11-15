/**
 * The library playground's state, shared by the build (src/lib/playground-render.ts),
 * the page script (playground.ts) and the worker (playground-worker.ts). Pure: no DOM,
 * no core import, so the page script stays small and the tests can import it.
 *
 * Every operation is written out as the JavaScript it runs. The worker runs exactly
 * that code, the page shows it, and "Edit as code" copies it into the code box.
 */

export type Source = 'fixture' | 'paste' | 'api';
export type Op = 'render' | 'chunk' | 'outline' | 'tokens' | 'agent' | 'clean';
export type Tri = '' | 'include' | 'omit';

/** FormatOptions keys the playground offers, in the order the form shows them. */
export const FORMAT_OPTIONS = [
  'timestamps',
  'offsetSec',
  'maxLineChars',
  'maxLines',
  'maxTokens',
  'linkTimestamps',
  'includeComments',
  'includeVisual',
  'secondary',
] as const;
export type FormatOptionKey = (typeof FORMAT_OPTIONS)[number];

/** A formatter as the page knows it (from the core `formatters` map at build time). */
export interface FormatInfo {
  id: string;
  description: string;
  extension: string;
  mimeType: string;
  /** The FormatOptions this formatter reads. */
  options: FormatOptionKey[];
  /** 'timestamps': offsetSec applies only with timestamps on (Formatter.timed). */
  timed?: 'always' | 'timestamps';
}

export interface PgState {
  source: Source;
  fixture: string;
  url: string;
  server: string;
  from: string;
  to: string;
  chapter: string;
  clean: boolean;
  tags: 'keep' | 'remove';
  quotes: 'keep' | 'straight';
  sentences: boolean;
  fillers: boolean;
  op: Op;
  format: string;
  timestamps: boolean;
  linkTimestamps: boolean;
  includeComments: Tri;
  includeVisual: Tri;
  offsetSec: string;
  maxLineChars: string;
  maxLines: string;
  maxTokens: string;
  chunkTokens: string;
  overlapTokens: string;
  by: '' | 'chapters' | 'time' | 'tokens';
  targetSec: string;
  agentTokens: string;
  agentComments: boolean;
  agentVisual: boolean;
  code: string;
}

export const OPS: { id: Op; label: string }[] = [
  { id: 'render', label: 'Render a format' },
  { id: 'chunk', label: 'Chunk for retrieval' },
  { id: 'outline', label: 'Outline with token counts' },
  { id: 'tokens', label: 'Token cost of every format' },
  { id: 'agent', label: 'Prompt for an agent' },
  { id: 'clean', label: 'Cleanup report' },
];

export interface Starter {
  id: string;
  label: string;
  code: string;
}

export const STARTERS: Starter[] = [
  {
    id: 'short-lines',
    label: 'Subtitles with short lines',
    code: "return core.render(context, 'srt', { maxLineChars: 24, maxLines: 1 });\n",
  },
  {
    id: 'chunks',
    label: 'Chunks with overlap',
    code: [
      'const chunks = core.chunkTranscript(context, { maxTokens: 120, overlapTokens: 20 });',
      'return chunks',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this string is code the worker runs
      '  .map((c) => `#${c.index} ${core.formatTimestamp(c.startSec)} to ${core.formatTimestamp(c.endSec)}, ${c.tokens} tokens\\n${c.text}`)',
      "  .join('\\n\\n');",
      '',
    ].join('\n'),
  },
  {
    id: 'search',
    label: 'Find a word',
    code: [
      'const word = /\\bthe\\b/i;',
      'const hits = context.transcript.segments.filter((s) => word.test(s.text));',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this string is code the worker runs
      'console.log(`${hits.length} of ${context.transcript.segments.length} segments match`);',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this string is code the worker runs
      "return hits.map((s) => `[${core.formatTimestamp(s.startSec)}] ${s.text}`).join('\\n');",
      '',
    ].join('\n'),
  },
];

export function defaultState(fixture: string): PgState {
  return {
    source: 'fixture',
    fixture,
    url: '',
    server: '',
    from: '',
    to: '',
    chapter: '',
    clean: false,
    tags: 'keep',
    quotes: 'keep',
    sentences: true,
    fillers: false,
    op: 'render',
    format: 'srt',
    timestamps: false,
    linkTimestamps: true,
    includeComments: '',
    includeVisual: '',
    offsetSec: '',
    maxLineChars: '',
    maxLines: '',
    maxTokens: '',
    chunkTokens: '500',
    overlapTokens: '0',
    by: '',
    targetSec: '',
    agentTokens: '',
    agentComments: true,
    agentVisual: true,
    code: (STARTERS[0] as Starter).code,
  };
}

const ENUMS: Partial<Record<keyof PgState, readonly string[]>> = {
  source: ['fixture', 'paste', 'api'],
  op: OPS.map((o) => o.id),
  tags: ['keep', 'remove'],
  quotes: ['keep', 'straight'],
  includeComments: ['', 'include', 'omit'],
  includeVisual: ['', 'include', 'omit'],
  by: ['', 'chapters', 'time', 'tokens'],
};

export const HASH_PREFIX = '#pg:';

/** The hash for a state: only the fields that differ from the defaults. */
export function encodeHash(state: PgState, defaults: PgState): string {
  const p = new URLSearchParams();
  for (const key of Object.keys(defaults) as (keyof PgState)[]) {
    const v = state[key];
    if (v === defaults[key]) continue;
    p.set(key, typeof v === 'boolean' ? (v ? '1' : '0') : v);
  }
  const s = p.toString();
  return s ? `${HASH_PREFIX}${s}` : '';
}

/** A state from a hash. Unknown keys and values outside an option list are ignored. */
export function decodeHash(hash: string, defaults: PgState): PgState | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const p = new URLSearchParams(hash.slice(HASH_PREFIX.length));
  const out: PgState = { ...defaults };
  const rec = out as unknown as Record<string, string | boolean>;
  for (const key of Object.keys(defaults) as (keyof PgState)[]) {
    const v = p.get(key);
    if (v === null) continue;
    if (typeof defaults[key] === 'boolean') rec[key] = v === '1';
    else if (!ENUMS[key] || ENUMS[key]?.includes(v)) rec[key] = v;
  }
  return out;
}

/** A JavaScript string literal in single quotes. */
export function q(s: string): string {
  return `'${s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;
}

/** An object literal. An entry whose value is its own key prints as shorthand, `{ secondary }`. */
function lit(entries: [string, string][]): string {
  if (!entries.length) return '{}';
  return `{ ${entries.map(([k, v]) => (v === k ? k : `${k}: ${v}`)).join(', ')} }`;
}

export class InputError extends Error {}

function num(label: string, raw: string, opts: { int?: boolean; min?: number } = {}): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new InputError(`${label} must be a number.`);
  if (opts.int && !Number.isInteger(n)) throw new InputError(`${label} must be a whole number.`);
  if (opts.min !== undefined && n < opts.min) throw new InputError(`${label} must be at least ${opts.min}.`);
  return String(n);
}

function time(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  return /^\d+(\.\d+)?$/.test(s) ? String(Number(s)) : `core.parseTimeArg(${q(s)})`;
}

function cleanOptions(s: PgState): string {
  const e: [string, string][] = [];
  if (s.tags === 'remove') e.push(['tags', q('remove')]);
  if (s.quotes === 'straight') e.push(['quotes', q('straight')]);
  if (!s.sentences) e.push(['sentences', 'false']);
  if (s.fillers) e.push(['fillers', 'true']);
  return lit(e);
}

function tri(v: Tri): string | undefined {
  return v === 'include' ? 'true' : v === 'omit' ? 'false' : undefined;
}

/** Whether a format option applies under the current state (offsetSec on text needs timestamps). */
export function optionApplies(f: FormatInfo, key: FormatOptionKey, s: Pick<PgState, 'timestamps'>): boolean {
  if (!f.options.includes(key)) return false;
  if (key === 'offsetSec' && f.timed === 'timestamps') return s.timestamps;
  return true;
}

/** FormatOptions for `render`, as an object literal. Throws InputError for a bad number. */
export function formatOptions(f: FormatInfo, s: PgState, hasSecondary: boolean): string {
  const e: [string, string][] = [];
  const on = (k: FormatOptionKey) => optionApplies(f, k, s);
  const add = (k: FormatOptionKey, v: string | undefined) => {
    if (v !== undefined && on(k)) e.push([k, v]);
  };
  if (s.timestamps) add('timestamps', 'true');
  const offset = num('Offset', s.offsetSec);
  if (offset !== '0') add('offsetSec', offset);
  add('maxLineChars', num('Line length', s.maxLineChars, { int: true, min: 1 }));
  add('maxLines', num('Lines per cue', s.maxLines, { int: true, min: 1 }));
  add('maxTokens', num('Token budget', s.maxTokens, { int: true, min: 1 }));
  if (!s.linkTimestamps) add('linkTimestamps', 'false');
  add('includeComments', tri(s.includeComments));
  add('includeVisual', tri(s.includeVisual));
  if (hasSecondary) add('secondary', 'secondary');
  return lit(e);
}

export interface OpCode {
  code: string;
  /** What Download saves. */
  extension: string;
  mimeType: string;
}

/**
 * The code an operation runs, with `core`, `context` and `secondary` in scope.
 * Throws InputError when a field cannot become valid code.
 */
export function opCode(s: PgState, formats: FormatInfo[], hasSecondary: boolean): OpCode {
  const lines: string[] = [];
  const sel: [string, string][] = [];
  const from = time(s.from);
  const to = time(s.to);
  if (from !== undefined) sel.push(['fromSec', from]);
  if (to !== undefined) sel.push(['toSec', to]);
  if (s.chapter !== '') sel.push(['chapter', num('Chapter', s.chapter, { int: true, min: 0 }) ?? '0']);
  if (sel.length) lines.push(`context = core.getSection(context, ${lit(sel)});`);
  if (s.op === 'clean') {
    lines.push(`return (await core.cleanTranscript(context.transcript, ${cleanOptions(s)})).report;`);
    return { code: `${lines.join('\n')}\n`, extension: 'json', mimeType: 'application/json' };
  }
  if (s.clean) {
    lines.push(
      `context = { ...context, transcript: (await core.cleanTranscript(context.transcript, ${cleanOptions(s)})).transcript };`,
    );
  }
  let out: Omit<OpCode, 'code'> = { extension: 'json', mimeType: 'application/json' };
  switch (s.op) {
    case 'render': {
      const f = formats.find((x) => x.id === s.format);
      if (!f) throw new InputError(`Unknown format "${s.format}".`);
      const opts = formatOptions(f, s, hasSecondary);
      lines.push(`return core.render(context, ${q(f.id)}${opts === '{}' ? '' : `, ${opts}`});`);
      out = { extension: f.extension, mimeType: f.mimeType };
      break;
    }
    case 'chunk': {
      const max = num('Tokens per chunk', s.chunkTokens, { int: true, min: 1 });
      if (max === undefined) throw new InputError('Tokens per chunk is required.');
      const e: [string, string][] = [['maxTokens', max]];
      const overlap = num('Overlap', s.overlapTokens, { int: true, min: 0 });
      if (overlap !== undefined && overlap !== '0') e.push(['overlapTokens', overlap]);
      if (s.by) e.push(['by', q(s.by)]);
      const target = s.by === 'time' ? num('Window', s.targetSec, { min: 1 }) : undefined;
      if (target !== undefined) e.push(['targetSec', target]);
      lines.push(`return core.chunkTranscript(context, ${lit(e)});`);
      break;
    }
    case 'outline':
      lines.push('return core.transcriptOutline(context);');
      break;
    case 'tokens':
      lines.push(
        'return Object.keys(core.formatters)',
        '  .map((id) => {',
        '    const out = core.render(context, id);',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this string is code the worker runs
        '    return `${id.padEnd(9)}${String(core.estimateTokens(out)).padStart(8)} tokens${String(out.length).padStart(9)} characters`;',
        '  })',
        "  .join('\\n');",
      );
      out = { extension: 'txt', mimeType: 'text/plain; charset=utf-8' };
      break;
    case 'agent': {
      const e: [string, string][] = [];
      const max = num('Token budget', s.agentTokens, { int: true, min: 1 });
      if (max !== undefined) e.push(['maxTokens', max]);
      if (!s.agentComments) e.push(['comments', 'false']);
      if (!s.agentVisual) e.push(['visual', 'false']);
      lines.push(`return core.agentPrompt([context]${e.length ? `, ${lit(e)}` : ''});`);
      out = { extension: 'md', mimeType: 'text/markdown; charset=utf-8' };
      break;
    }
  }
  return { code: `${lines.join('\n')}\n`, ...out };
}

// ------------------------------------------------------------------ worker messages

export interface RunRequest {
  id: number;
  code: string;
  context: unknown;
  secondary?: unknown;
  /** Also send the returned value itself (for the page's own queries, such as the outline). */
  wantValue?: boolean;
}

export interface RunError {
  name: string;
  message: string;
  code?: string;
  hint?: string;
}

export type RunResponse =
  | {
      id: number;
      ok: true;
      text: string;
      kind: 'text' | 'json' | 'empty';
      value?: unknown;
      logs: string[];
      ms: number;
      tokens: number;
    }
  | { id: number; ok: false; error: RunError; logs: string[]; ms: number };

/** An error as the page shows it: the name and code, the message, then the hint. */
export function presentRunError(e: RunError): string {
  const head = e.code ? `${e.name} (${e.code})` : e.name;
  return `${head}: ${e.message}${e.hint ? `\nhint: ${e.hint}` : ''}`;
}

/** The API's error body, {error:{code,message,hint}}, as text; null when the body is not one. */
export function presentApiError(status: number, body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string; hint?: string } };
    if (!parsed?.error) return null;
    const { code, message, hint } = parsed.error;
    return `HTTP ${status}\n${code}: ${message}${hint ? `\nhint: ${hint}` : ''}`;
  } catch {
    return null;
  }
}

/** Checks the shape the formatters rely on. Returns a problem in plain words, or null. */
export function contextProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Expected a JSON object (a VideoContext).';
  const c = value as { metadata?: unknown; transcript?: unknown };
  const m = c.metadata as { title?: unknown; ref?: unknown; chapters?: unknown } | undefined;
  if (!m || typeof m !== 'object') return 'metadata is missing.';
  if (typeof m.title !== 'string') return 'metadata.title must be a string.';
  if (!m.ref || typeof m.ref !== 'object') return 'metadata.ref is missing.';
  if (!Array.isArray(m.chapters)) return 'metadata.chapters must be an array (empty when the video has none).';
  return segmentsProblem(c.transcript, 'transcript');
}

/** The same check for a Transcript (the bilingual second transcript). */
export function segmentsProblem(t: unknown, where: string): string | null {
  const segs = (t as { segments?: unknown } | undefined)?.segments;
  if (!t || typeof t !== 'object' || !Array.isArray(segs)) return `${where}.segments must be an array.`;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as { startSec?: unknown; endSec?: unknown; text?: unknown } | null;
    if (!s || typeof s.startSec !== 'number' || typeof s.endSec !== 'number' || typeof s.text !== 'string') {
      return `${where}.segments[${i}] needs startSec and endSec (numbers) and text (a string).`;
    }
  }
  return null;
}

/** A second transcript from pasted JSON: a Transcript, or the transcript of a VideoContext. */
export function secondaryFrom(value: unknown): { transcript?: unknown; problem?: string } {
  const v = value as { transcript?: unknown; segments?: unknown } | null;
  const t = v && typeof v === 'object' && !Array.isArray(v.segments) && v.transcript ? v.transcript : v;
  const problem = segmentsProblem(t, t === v ? 'The transcript' : 'transcript');
  return problem ? { problem } : { transcript: t };
}

export function formatSeconds(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** One line about a loaded context. */
export function contextSummary(c: {
  metadata: { title: string; durationSec?: number; chapters: unknown[] };
  transcript: { segments: { endSec: number }[]; language?: string; origin?: string };
}): string {
  const segs = c.transcript.segments;
  const dur = c.metadata.durationSec ?? segs.at(-1)?.endSec ?? 0;
  const parts = [
    `${segs.length} segment${segs.length === 1 ? '' : 's'}`,
    formatSeconds(dur),
    c.transcript.language,
    c.transcript.origin?.replace(/-/g, ' '),
    `${c.metadata.chapters.length} chapter${c.metadata.chapters.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return `${c.metadata.title}: ${parts.join(', ')}`;
}
