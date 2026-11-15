/**
 * Runnable examples: every block on a page has a spec, every spec a recorded
 * response whose request is exactly what the spec sends by default, nothing
 * private is recorded, and the generated snippets are correct code. Runs on
 * the sources and fixtures, no build or network needed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runnables } from '../src/data/runnables.ts';
import { privacyProblem } from '../src/lib/fixture-privacy.ts';
import {
  buildRequest,
  cliSnippet,
  curlSnippet,
  defaults,
  fetchSnippet,
  fromBase64,
  highlightCode,
  InputError,
  mcpSnippet,
  parseSse,
  presentSse,
  pythonSnippet,
  queryString,
  type Recording,
  type RunnableSpec,
  shq,
  snippets,
  zipEntries,
} from '../src/lib/runnable.ts';

const root = join(import.meta.dirname, '..', '..');
const fixtureDir = join(root, 'site/test/fixtures/runnables');
const contentDir = join(root, 'site/src/content');
const opts = { base: 'https://vid2context.com', auth: false, cliPrefix: 'npx -y vid2context' };
const recording = (id: string) => JSON.parse(readFileSync(join(fixtureDir, `${id}.json`), 'utf8')) as Recording;

function contentFences(): { file: string; id: string }[] {
  const out: { file: string; id: string }[] = [];
  for (const dir of readdirSync(contentDir)) {
    for (const file of readdirSync(join(contentDir, dir)).filter((f) => f.endsWith('.md'))) {
      const md = readFileSync(join(contentDir, dir, file), 'utf8');
      for (const m of md.matchAll(/^```run\s+(\S+)\s*$/gm)) out.push({ file: `${dir}/${file}`, id: m[1] as string });
    }
  }
  return out;
}

describe('the catalog and the pages', () => {
  const ids = runnables.map((r) => r.id);

  it('has unique ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every run block on a page names a spec', () => {
    const unknown = contentFences().filter((f) => !ids.includes(f.id));
    expect(unknown).toEqual([]);
  });

  it('every spec is used on at least one page', () => {
    const used = new Set(contentFences().map((f) => f.id));
    expect(ids.filter((id) => !used.has(id))).toEqual([]);
  });

  it('every field a later block reads from is provided by an earlier one', () => {
    for (const [n, spec] of runnables.entries()) {
      for (const f of spec.fields.filter((x) => x.from)) {
        const provider = runnables.slice(0, n).find((r) => r.provides?.name === f.from);
        expect(provider, `${spec.id}.${f.name} reads "${f.from}"`).toBeDefined();
      }
    }
  });

  it('every select default is one of its options', () => {
    for (const spec of runnables)
      for (const f of spec.fields.filter((x) => x.type === 'select'))
        expect(f.options, `${spec.id}.${f.name}`).toContain(f.default ?? '');
  });
});

describe('recorded responses', () => {
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));

  it('there is one per spec, and no stale ones', () => {
    expect(files.map((f) => f.replace(/\.json$/, '')).sort()).toEqual(runnables.map((r) => r.id).sort());
  });

  it.each(runnables.map((r) => [r.id, r] as const))('%s was recorded with the request the spec sends by default', (_id, spec) => {
    const rec = recording(spec.id);
    const req = buildRequest(spec, defaults(spec));
    expect(rec.request.method).toBe(req.method);
    expect(rec.request.path).toBe(req.path);
    expect(rec.request.query).toEqual(req.query);
    expect(rec.request.json).toEqual(req.json);
    expect(rec.request.file).toEqual(req.file);
  });

  it.each(files)('%s holds nothing private', (file) => {
    expect(privacyProblem(readFileSync(join(fixtureDir, file), 'utf8'))).toBeNull();
  });

  it('successful examples succeeded, and the error example is an error', () => {
    for (const spec of runnables) {
      const rec = recording(spec.id);
      if (spec.id === 'transcript-error') {
        expect(rec.status).toBeGreaterThanOrEqual(400);
        expect(JSON.parse(rec.body ?? '{}').error.code).toBeTypeOf('string');
        continue;
      }
      expect(rec.status, spec.id).toBeLessThan(300);
      if (rec.job) expect((rec.job.final as { status: string }).status, spec.id).toBe('succeeded');
    }
  });

  it('the bundle is a real zip with context.md in it', () => {
    const names = zipEntries(fromBase64(recording('bundle').bodyBase64 ?? '')).map((e) => e.name);
    expect(names.some((n) => n.endsWith('/context.md'))).toBe(true);
  });

  it('the streamed answer has meta, the answer and done', () => {
    const text = recording('ask-stream').body ?? '';
    const events = parseSse(text).map((e) => e.event);
    expect(events[0]).toBe('meta');
    expect(events.at(-1)).toBe('done');
    const answer = JSON.parse(parseSse(text).find((e) => e.event === 'done')?.data ?? '{}').text as string;
    expect(presentSse(text)).toContain(answer);
  });

  it('the upload example chains the real input into the next block', () => {
    const input = JSON.parse(recording('upload').body ?? '{}').input as string;
    const next = runnables.find((r) => r.id === 'upload-transcript');
    expect(next?.fields.find((f) => f.from === 'upload')?.default).toBe(input);
  });

  it('the collection examples chain the id the create example really returned', () => {
    const id = JSON.parse(recording('collection-create').body ?? '{}').id as string;
    const readers = runnables.filter((r) => r.fields.some((f) => f.from === 'collection'));
    expect(readers.map((r) => r.id)).toEqual(['collection-add', 'collection-get', 'collection-pack', 'collection-export']);
    for (const r of readers) expect(r.fields.find((f) => f.from === 'collection')?.default, r.id).toBe(id);
    const final = recording('collection-add').job?.final as { result: { summary: { added: unknown[] } } } | undefined;
    expect(final?.result.summary.added).toHaveLength(2);
    expect(JSON.parse(recording('collection-get').body ?? '{}').videos).toHaveLength(2);
  });

  it('the import example keeps the pasted captions as imported segments', () => {
    const spec = runnables.find((r) => r.id === 'import-transcript');
    const text = spec?.fields.find((f) => f.name === 'text');
    expect(text?.type).toBe('textarea');
    const body = JSON.parse(recording('import-transcript').body ?? '{}');
    expect(body.format).toBe('srt');
    expect(body.context.transcript.origin).toBe('imported');
    expect(body.context.transcript.segments[0].text).toBe('All right, so here we are, in front of the elephants');
    expect(body.context.transcript.segments).toHaveLength(6);
  });
});

// ------------------------------------------------------------------ snippets

const spec = (over: Partial<RunnableSpec>): RunnableSpec => ({
  id: 't',
  title: 'T',
  method: 'GET',
  path: '/api/v1/transcript',
  fields: [],
  response: 'text',
  ...over,
});

describe('requests', () => {
  it('leaves out empty optional fields and unchecked boxes, and sends checked ones as 1', () => {
    const s = spec({
      fields: [
        { name: 'url', label: 'URL', type: 'url', in: 'query', default: 'abc' },
        { name: 'lang', label: 'Lang', type: 'text', in: 'query', default: '', optional: true },
        { name: 'ts', label: 'TS', type: 'checkbox', in: 'query', default: '' },
        { name: 'on', label: 'On', type: 'checkbox', in: 'query', key: 'timestamps', default: 'true' },
      ],
    });
    expect(buildRequest(s, defaults(s)).query).toEqual([
      ['url', 'abc'],
      ['timestamps', '1'],
    ]);
  });

  it('leaves out a field at the server default but keeps other values', () => {
    const s = spec({
      fields: [
        {
          name: 'mode',
          label: 'Mode',
          type: 'select',
          in: 'query',
          default: 'auto',
          serverDefault: 'auto',
          options: ['auto', 'stt'],
        },
      ],
    });
    expect(buildRequest(s, { mode: 'auto' }).query).toEqual([]);
    expect(buildRequest(s, { mode: 'stt' }).query).toEqual([['mode', 'stt']]);
  });

  it('types body values: numbers, booleans, lists and JSON', () => {
    const s = spec({
      method: 'POST',
      fields: [
        { name: 'n', label: 'N', type: 'number', in: 'body', default: '5' },
        { name: 'b', label: 'B', type: 'checkbox', in: 'body', default: 'true' },
        { name: 'l', label: 'L', type: 'list', in: 'body', default: ' a \n\n b ' },
        { name: 'j', label: 'J', type: 'json', in: 'body', default: '{"x":[1]}' },
      ],
      fixedBody: { stream: true },
    });
    expect(buildRequest(s, defaults(s)).json).toEqual({ n: 5, b: true, l: ['a', 'b'], j: { x: [1] }, stream: true });
  });

  it('rejects a missing required value, a bad number and bad JSON with InputError', () => {
    const req = spec({ fields: [{ name: 'url', label: 'Video URL', type: 'url', in: 'query' }] });
    expect(() => buildRequest(req, { url: ' ' })).toThrow(InputError);
    const num = spec({ method: 'POST', fields: [{ name: 'n', label: 'N', type: 'number', in: 'body' }] });
    expect(() => buildRequest(num, { n: 'many' })).toThrow('N must be a number.');
    const json = spec({ method: 'POST', fields: [{ name: 'j', label: 'Schema', type: 'json', in: 'body' }] });
    expect(() => buildRequest(json, { j: '{' })).toThrow(/Schema is not valid JSON/);
  });

  it('fills and encodes path segments', () => {
    const s = spec({ path: '/api/v1/library/{id}', fields: [{ name: 'id', label: 'Id', type: 'text', in: 'path' }] });
    expect(buildRequest(s, { id: 'youtube:abc' }).path).toBe('/api/v1/library/youtube%3Aabc');
  });

  it('encodes the query string', () => {
    expect(queryString([['url', 'https://x.test/?a=1&b=2']])).toBe('?url=https%3A%2F%2Fx.test%2F%3Fa%3D1%26b%3D2');
  });
});

describe('snippets', () => {
  const transcript = runnables.find((r) => r.id === 'transcript-timestamps') as RunnableSpec;

  it('quotes shell words only when needed, including single quotes', () => {
    expect(shq('format=text')).toBe('format=text');
    expect(shq("it's & more")).toBe(`'it'\\''s & more'`);
  });

  it('curl uses -G with --data-urlencode for GET parameters', () => {
    const code = curlSnippet(transcript, buildRequest(transcript, defaults(transcript)), opts);
    expect(code).toContain('curl -G https://vid2context.com/api/v1/transcript');
    expect(code).toContain("--data-urlencode 'url=https://www.youtube.com/watch?v=jNQXAC9IVRw'");
    expect(code).toContain('--data-urlencode timestamps=1');
  });

  it('curl sends JSON bodies, files, zips and streams correctly', () => {
    const pack = runnables.find((r) => r.id === 'pack-many') as RunnableSpec;
    expect(curlSnippet(pack, buildRequest(pack, defaults(pack)), opts)).toContain(`-H 'Content-Type: application/json'`);
    const upload = runnables.find((r) => r.id === 'upload') as RunnableSpec;
    expect(curlSnippet(upload, buildRequest(upload, defaults(upload)), opts)).toContain('-F file=@apollo11-small-step.mp3');
    const bundle = runnables.find((r) => r.id === 'bundle') as RunnableSpec;
    expect(curlSnippet(bundle, buildRequest(bundle, defaults(bundle)), opts)).toMatch(/^curl -OJ -G /);
    const stream = runnables.find((r) => r.id === 'ask-stream') as RunnableSpec;
    expect(curlSnippet(stream, buildRequest(stream, defaults(stream)), opts)).toMatch(/^curl -N /);
  });

  it('reads the key from the environment and never prints it', () => {
    const all = snippets(transcript, defaults(transcript), { ...opts, auth: true })
      .map((s) => s.code)
      .join('\n');
    expect(all).toContain('$VID2CONTEXT_API_KEY');
    expect(all).toContain('process.env.VID2CONTEXT_API_KEY');
    expect(all).toContain("os.environ['VID2CONTEXT_API_KEY']");
  });

  it('builds the CLI command and hides it when a field has no CLI flag', () => {
    expect(cliSnippet(transcript, defaults(transcript), opts)).toBe(
      "npx -y vid2context get 'https://www.youtube.com/watch?v=jNQXAC9IVRw' --format text --timestamps",
    );
    const translate = runnables.find((r) => r.id === 'transcript-translate') as RunnableSpec;
    expect(cliSnippet(translate, defaults(translate), opts)).toBeNull();
    expect(cliSnippet(translate, { ...defaults(translate), translate: '' }, opts)).toContain('--lang de');
  });

  it('builds the MCP call with typed arguments', () => {
    const call = JSON.parse(mcpSnippet(transcript, defaults(transcript)) ?? '{}');
    expect(call).toEqual({
      name: 'get_transcript',
      arguments: { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', format: 'text', timestamps: true },
    });
    const brief = runnables.find((r) => r.id === 'brief') as RunnableSpec;
    expect(JSON.parse(mcpSnippet(brief, defaults(brief)) ?? '{}').arguments.format).toBe('json');
  });

  it('escapes HTML while highlighting', () => {
    expect(highlightCode('"<b>"', 'json')).toBe('<span class="tk-str">&quot;&lt;b&gt;&quot;</span>');
    expect(highlightCode('a < b', 'text')).toBe('a &lt; b');
  });

  it('every JavaScript snippet is valid code, with and without a key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2c-snippets-'));
    for (const s of runnables) {
      for (const auth of [false, true]) {
        const file = join(dir, `${s.id}-${auth}.mjs`);
        writeFileSync(file, fetchSnippet(s, buildRequest(s, defaults(s)), { ...opts, auth }));
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      }
    }
  });

  it('every Python snippet compiles, with and without a key', () => {
    let python: string | null = null;
    for (const bin of ['python3', 'python']) {
      try {
        execFileSync(bin, ['--version'], { stdio: 'pipe' });
        python = bin;
        break;
      } catch {
        // try the next name
      }
    }
    if (!python) {
      console.error('Python is not installed; skipped compiling the Python snippets.');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'v2c-snippets-'));
    for (const s of runnables) {
      for (const auth of [false, true]) {
        const file = join(dir, `${s.id.replace(/-/g, '_')}_${auth}.py`);
        writeFileSync(file, pythonSnippet(s, buildRequest(s, defaults(s)), { ...opts, auth }));
        execFileSync(python, ['-I', '-m', 'py_compile', file], { stdio: 'pipe' });
      }
    }
  });
});
