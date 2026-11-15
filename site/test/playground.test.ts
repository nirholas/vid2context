/**
 * The library playground: the form's code generation runs against the real core
 * on the real fixtures, each formatter's option list matches what core actually
 * reads, the hash round-trips, and only the playground page loads its script.
 * The last block reads dist/, so run `npm run build:site` first.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { fixtureInfos, formatInfos, formatOptionsOf, loadFixture, playgroundWidget } from '../src/lib/playground-render.ts';
import {
  contextProblem,
  decodeHash,
  defaultState,
  encodeHash,
  FORMAT_OPTIONS,
  type FormatOptionKey,
  InputError,
  OPS,
  opCode,
  type PgState,
  presentApiError,
  presentRunError,
  q,
  STARTERS,
  secondaryFrom,
} from '../src/scripts/playground-state.ts';

const root = join(import.meta.dirname, '..', '..');
const dist = join(root, 'site/dist');
const fixtures = fixtureInfos();
const formats = formatInfos();
const first = fixtures[0]?.id ?? '';
const defaults = defaultState(first);

type Fn = (...a: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...a: string[]) => Fn;
/** What the worker does with a snippet, minus the worker. */
const run = (code: string, context: unknown, secondary?: unknown) =>
  new AsyncFunction('core', 'context', 'secondary', 'console', code)(core, structuredClone(context), secondary, console);

describe('fixtures and formats', () => {
  it('lists every context fixture, smallest first', () => {
    const files = readdirSync(join(root, 'tests/fixtures/contexts')).filter((f) => f.endsWith('.json'));
    expect(fixtures.map((f) => `${f.id}.json`).sort()).toEqual(files.sort());
    for (const f of fixtures) expect(contextProblem(loadFixture(f.id))).toBeNull();
    expect(fixtures.map((f) => f.segments)).toEqual([...fixtures.map((f) => f.segments)].sort((a, b) => a - b));
  });

  it('offers every formatter in core', () => {
    expect(formats.map((f) => f.id)).toEqual(Object.keys(core.formatters));
  });

  // Each option is set to a value that must show in the output when the formatter reads it.
  const variant: Record<
    Exclude<FormatOptionKey, 'includeComments' | 'includeVisual'>,
    (c: core.VideoContext) => core.FormatOptions
  > = {
    timestamps: () => ({ timestamps: true }),
    offsetSec: () => ({ offsetSec: 2.5 }),
    maxLineChars: () => ({ maxLineChars: 12 }),
    maxLines: () => ({ maxLines: 1, maxLineChars: 12 }),
    maxTokens: () => ({ maxTokens: 300 }),
    linkTimestamps: () => ({ linkTimestamps: false }),
    secondary: (c) => ({ secondary: c.transcript }),
  };
  const big = loadFixture(fixtures.at(-1)?.id ?? first);

  for (const f of Object.values(core.formatters)) {
    it(`${f.id}: the options shown are exactly the ones core reads`, () => {
      const listed = formatOptionsOf(f);
      for (const [key, make] of Object.entries(variant) as [
        keyof typeof variant,
        (c: core.VideoContext) => core.FormatOptions,
      ][]) {
        // offsetSec on text only applies with timestamps, so compare against a timestamped base there.
        const base: core.FormatOptions = key === 'offsetSec' && f.timed === 'timestamps' ? { timestamps: true } : {};
        const before = core.render(big, f.id, base);
        const after = core.render(big, f.id, { ...base, ...make(big) });
        expect(after !== before, `${f.id} ${key}`).toBe(listed.includes(key));
      }
    });
  }

  it('comments and visual notes are offered where the formatter source reads them', () => {
    // No fixture has comments or visual notes, so these two are checked against the source.
    const dir = join(root, 'packages/core/src/format');
    for (const f of Object.values(core.formatters)) {
      const file = join(dir, `${f.id}.ts`);
      const src = existsSync(file) ? readFileSync(file, 'utf8') : '';
      for (const key of ['includeComments', 'includeVisual'] as const) {
        expect(formatOptionsOf(f).includes(key), `${f.id} ${key}`).toBe(src.includes(`opts.${key}`));
      }
    }
  });

  it('lists only options the playground knows', () => {
    for (const f of formats) for (const o of f.options) expect(FORMAT_OPTIONS).toContain(o);
  });
});

describe('generated code', () => {
  const states: [string, Partial<PgState>][] = [
    ['default', {}],
    ['text with timestamps and an offset', { format: 'text', timestamps: true, offsetSec: '-1.5' }],
    [
      'srt with layout and cleanup',
      { format: 'srt', maxLineChars: '20', maxLines: '1', clean: true, tags: 'remove', fillers: true },
    ],
    ['pack on a budget without links', { format: 'pack', maxTokens: '400', linkTimestamps: false, includeComments: 'omit' }],
    ['markdown of one chapter', { format: 'markdown', chapter: '0' }],
    ['a time range in m:ss', { format: 'vtt', from: '0:05', to: '12' }],
    ['chunks by time', { op: 'chunk', chunkTokens: '80', overlapTokens: '10', by: 'time', targetSec: '60' }],
    ['outline', { op: 'outline' }],
    ['tokens', { op: 'tokens' }],
    ['agent prompt', { op: 'agent', agentTokens: '1500', agentComments: false }],
    ['cleanup report', { op: 'clean', quotes: 'straight', sentences: false }],
  ];
  for (const fx of fixtures) {
    for (const [name, patch] of states) {
      it(`${fx.id}: ${name} runs against core`, async () => {
        const s = { ...defaultState(fx.id), ...patch };
        const { code } = opCode(s, formats, false);
        const out = await run(code, loadFixture(fx.id));
        expect(out).toBeDefined();
        if (s.op === 'render') expect(typeof out).toBe('string');
      });
    }
  }

  it('renders exactly what core.render gives', async () => {
    const c = loadFixture(first);
    const s: PgState = { ...defaults, format: 'srt', maxLineChars: '20', offsetSec: '1' };
    const { code, extension, mimeType } = opCode(s, formats, false);
    expect(code).toBe("return core.render(context, 'srt', { offsetSec: 1, maxLineChars: 20 });\n");
    expect(await run(code, c)).toBe(core.render(c, 'srt', { offsetSec: 1, maxLineChars: 20 }));
    expect([extension, mimeType]).toEqual([core.formatters.srt?.extension, core.formatters.srt?.mimeType]);
  });

  it('leaves out options the chosen format does not read', () => {
    const { code } = opCode({ ...defaults, format: 'json', timestamps: true, maxLineChars: '20' }, formats, true);
    expect(code).toBe("return core.render(context, 'json');\n");
    expect(opCode({ ...defaults, format: 'text', offsetSec: '3' }, formats, false).code).toBe(
      "return core.render(context, 'text');\n",
    );
  });

  it('passes the second transcript to bilingual formats', async () => {
    const c = loadFixture(first);
    const { code } = opCode({ ...defaults, format: 'vtt' }, formats, true);
    expect(code).toBe("return core.render(context, 'vtt', { secondary });\n");
    expect(await run(code, c, c.transcript)).toBe(core.render(c, 'vtt', { secondary: c.transcript }));
  });

  it('says which field is wrong instead of writing broken code', () => {
    expect(() => opCode({ ...defaults, maxLineChars: '2.5' }, formats, false)).toThrow(InputError);
    expect(() => opCode({ ...defaults, op: 'chunk', chunkTokens: '' }, formats, false)).toThrow('Tokens per chunk is required.');
  });

  it('core errors come back with their code and hint', async () => {
    const { code } = opCode({ ...defaults, op: 'chunk', chunkTokens: '10', overlapTokens: '20' }, formats, false);
    const err = (await run(code, loadFixture(first)).catch((e: unknown) => e)) as core.Vid2ContextError;
    expect(err).toBeInstanceOf(core.Vid2ContextError);
    expect(presentRunError({ name: err.name, message: err.message, code: err.code, hint: err.hint })).toMatch(
      /^Vid2ContextError \(bad-request\): overlapTokens \(20\) must be smaller than maxTokens \(10\)\.\nhint: /,
    );
  });

  it('every starter runs on every fixture', async () => {
    for (const fx of fixtures) {
      for (const s of STARTERS) expect(typeof (await run(s.code, loadFixture(fx.id)))).toBe('string');
    }
  });

  it('quotes strings safely', () => {
    expect(q("it's\n\\")).toBe("'it\\'s\\n\\\\'");
    // biome-ignore lint/security/noGlobalEval: checks that the literal parses back to the same string
    expect(eval(q("a'b c"))).toBe("a'b c");
  });
});

describe('state in the hash', () => {
  it('round-trips every field and drops defaults', () => {
    expect(encodeHash(defaults, defaults)).toBe('');
    const s: PgState = {
      ...defaults,
      source: 'api',
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      op: 'chunk',
      clean: true,
      sentences: false,
      by: 'time',
      chunkTokens: '80',
      code: 'return core.render(context, "csv");\n',
    };
    const h = encodeHash(s, defaults);
    expect(h.startsWith('#pg:')).toBe(true);
    expect(decodeHash(h, defaults)).toEqual(s);
  });

  it('ignores other anchors and values outside an option list', () => {
    expect(decodeHash('#what-you-can-change', defaults)).toBeNull();
    const s = decodeHash('#pg:op=nope&source=paste&by=minutes&clean=1', defaults);
    expect(s).toEqual({ ...defaults, source: 'paste', clean: true });
  });

  it('every operation has a label', () => {
    expect(OPS.map((o) => o.id)).toEqual(['render', 'chunk', 'outline', 'tokens', 'agent', 'clean']);
  });
});

describe('inputs', () => {
  it('explains a context that is not one', () => {
    expect(contextProblem([])).toMatch(/JSON object/);
    expect(
      contextProblem({ metadata: { title: 'x', ref: {}, chapters: [] }, transcript: { segments: [{ startSec: 0 }] } }),
    ).toMatch(/segments\[0\] needs startSec/);
  });

  it('takes a Transcript or a whole VideoContext as the second transcript', () => {
    const c = loadFixture(first);
    expect(secondaryFrom(c).transcript).toEqual(c.transcript);
    expect(secondaryFrom(c.transcript).transcript).toEqual(c.transcript);
    expect(secondaryFrom({ nope: 1 }).problem).toMatch(/segments must be an array/);
  });

  it('shows API errors in the {error:{code,message,hint}} shape', () => {
    const body = JSON.stringify({ error: { code: 'bad-request', message: 'No url.', hint: 'Pass ?url=' } });
    expect(presentApiError(400, body)).toBe('HTTP 400\nbad-request: No url.\nhint: Pass ?url=');
    expect(presentApiError(502, '<html>')).toBeNull();
  });
});

describe('markup', () => {
  it('renders the default run at build time and a twin with its code and output', () => {
    const html = playgroundWidget.html();
    const out = core.render(loadFixture(first), 'srt');
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    expect(html).toContain(esc(out));
    expect(html).toContain(esc(opCode(defaults, formats, false).code));
    const twin = playgroundWidget.twin();
    expect(twin).toContain(out.trimEnd());
    expect(twin).not.toMatch(/[\u2013\u2014]/);
  });
});

describe.skipIf(!existsSync(join(dist, 'docs/examples/playground/index.html')))('built site', () => {
  const page = (p: string) => readFileSync(join(dist, p), 'utf8');

  it('the playground page loads its script and the others do not', () => {
    expect(page('docs/examples/playground/index.html')).toMatch(/PlaygroundRuntime[^"]*\.js/);
    for (const p of ['index.html', 'docs/index.html', 'docs/examples/transcripts/index.html']) {
      expect(page(p)).not.toMatch(/PlaygroundRuntime[^"]*\.js/);
    }
  });

  it('core ships only in the worker, never in the page script', () => {
    const assets = readdirSync(join(dist, '_astro'));
    const script = assets.find((a) => a.startsWith('PlaygroundRuntime') && a.endsWith('.js'));
    expect(script).toBeDefined();
    const js = readFileSync(join(dist, '_astro', script ?? ''), 'utf8');
    expect(js).toMatch(/playground-worker-[\w-]+\.js/);
    expect(js).not.toContain('Vid2ContextError');
    expect(assets.some((a) => a.startsWith('playground-worker-'))).toBe(true);
  });
});
