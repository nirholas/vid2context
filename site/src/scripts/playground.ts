/**
 * The library playground on /docs/examples/playground/ (loaded by
 * components/playground/PlaygroundRuntime.astro only on pages with a
 * `widget playground` block). The form becomes code (playground-state.ts), the
 * code runs against @vid2context/core in a Web Worker (playground-worker.ts),
 * and the state lives in the URL hash so a link reproduces the run.
 */
import {
  contextProblem,
  contextSummary,
  decodeHash,
  defaultState,
  encodeHash,
  FORMAT_OPTIONS,
  type FormatInfo,
  HASH_PREFIX,
  InputError,
  OPS,
  type OpCode,
  opCode,
  optionApplies,
  type PgState,
  presentApiError,
  presentRunError,
  type RunRequest,
  type RunResponse,
  STARTERS,
  secondaryFrom,
} from './playground-state.ts';

/** The real fixtures, bundled as separate files and fetched only when chosen. */
const fixtureFiles = import.meta.glob<string>('../../../tests/fixtures/contexts/*.json', { query: '?raw', import: 'default' });
const fixtures = new Map(
  Object.entries(fixtureFiles).map(([path, load]) => [(path.split('/').pop() ?? path).replace(/\.json$/, ''), load]),
);

const OP_TIMEOUT_MS = 10_000;
const SNIPPET_TIMEOUT_MS = 5_000;

type Context = Parameters<typeof contextSummary>[0];
type Outcome = RunResponse | { id: number; ok: false; stopped: string };

function newWorker(): Worker {
  return new Worker(new URL('./playground-worker.ts', import.meta.url), { type: 'module', name: 'vid2context-playground' });
}

/** Posts one request to a worker and waits for its answer, stopping the worker after `timeoutMs`. */
function ask(worker: Worker, req: RunRequest, timeoutMs: number, onStop: () => void): Promise<Outcome> {
  return new Promise((resolve) => {
    const done = (o: Outcome) => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve(o);
    };
    const onMessage = (e: MessageEvent<RunResponse>) => {
      if (e.data.id === req.id) done(e.data);
    };
    const onError = (e: ErrorEvent) => {
      e.preventDefault();
      onStop();
      done({ id: req.id, ok: false, stopped: `The worker failed: ${e.message || 'it could not load @vid2context/core'}.` });
    };
    const timer = setTimeout(() => {
      onStop();
      done({
        id: req.id,
        ok: false,
        stopped: `Stopped after ${timeoutMs / 1000} seconds: the code did not finish. Look for a loop that never ends.`,
      });
    }, timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(req);
  });
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'video'
  );
}

function unreachable(base: string, own: boolean): string {
  if (!own) {
    return [
      `No API answered at ${base}.`,
      '',
      'This copy of the docs is served without the HTTP API (for example by astro dev or a static host).',
      'Set a server URL, for example one started from a clone of the repo:',
      '',
      `  VID2CONTEXT_CORS_ORIGINS=${location.origin} npm run start:server`,
      '',
      'It listens on http://127.0.0.1:8787.',
    ].join('\n');
  }
  return [
    `Could not reach ${base}.`,
    '',
    'Start the server from a clone of the repo, allowing this page to call it:',
    '',
    `  VID2CONTEXT_CORS_ORIGINS=${location.origin} npm run start:server`,
    '',
    'Without that variable the server answers, but the browser blocks the response (CORS).',
  ].join('\n');
}

interface Shown {
  text: string;
  extension: string;
  mimeType: string;
}

class Playground {
  private readonly formats: FormatInfo[];
  private readonly defaults: PgState;
  private st: PgState;
  private context: Context | null = null;
  private secondary: unknown;
  private opsWorker: Worker | null = null;
  private seq = 0;
  private opSeq = 0;
  private sourceSeq = 0;
  private opTimer: ReturnType<typeof setTimeout> | undefined;
  private written = '';
  private current: OpCode | null = null;
  private readonly shown: Record<'op' | 'snippet', Shown | null> = { op: null, snippet: null };

  constructor(private readonly root: HTMLElement) {
    this.formats = JSON.parse(root.dataset.pgFormats ?? '[]') as FormatInfo[];
    this.defaults = defaultState(root.dataset.pgDefault ?? '');
    const fromHash = decodeHash(location.hash, this.defaults);
    this.st = this.valid(fromHash ?? this.defaults);
    this.write(this.st);
    this.layout();
    this.bind();
    void this.loadSource(true).then(() => {
      if (fromHash && fromHash.code !== this.defaults.code) void this.runSnippet();
    });
    window.addEventListener('hashchange', () => this.onHash());
  }

  // ---------------------------------------------------------------- elements

  private q<T extends Element = HTMLElement>(sel: string): T {
    const el = this.root.querySelector<T>(sel);
    if (!el) throw new Error(`Playground markup is missing ${sel}.`);
    return el;
  }

  private field(name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
    return this.q(`[data-pg-field="${name}"]`);
  }

  private valid(s: PgState): PgState {
    const out = { ...s };
    if (!fixtures.has(out.fixture)) out.fixture = this.defaults.fixture;
    if (!this.formats.some((f) => f.id === out.format)) out.format = this.defaults.format;
    return out;
  }

  // ---------------------------------------------------------------- state and form

  private read(): PgState {
    const s = { ...this.st };
    const rec = s as unknown as Record<string, string | boolean>;
    for (const key of Object.keys(this.defaults) as (keyof PgState)[]) {
      if (key === 'code') continue;
      if (key === 'source') {
        const on = this.root.querySelector<HTMLInputElement>('[data-pg-field="source"]:checked');
        if (on) s.source = on.value as PgState['source'];
        continue;
      }
      const el = this.root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-pg-field="${key}"]`);
      if (!el) continue;
      rec[key] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
    }
    s.code = this.q<HTMLTextAreaElement>('[data-pg-code]').value;
    return s;
  }

  private write(s: PgState): void {
    for (const key of Object.keys(s) as (keyof PgState)[]) {
      const v = s[key];
      if (key === 'code') continue;
      if (key === 'source') {
        for (const r of this.root.querySelectorAll<HTMLInputElement>('[data-pg-field="source"]')) r.checked = r.value === v;
        continue;
      }
      const el = this.root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-pg-field="${key}"]`);
      if (!el) continue;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = v as boolean;
      else if (key === 'chapter' && el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === v)) {
        // The outline fills the chapter list once the context loads; keep the wanted value until then.
        el.add(new Option(`Section ${v}`, v as string));
        el.value = v as string;
      } else el.value = v as string;
    }
    this.q<HTMLTextAreaElement>('[data-pg-code]').value = s.code;
  }

  /** Shows the fields that apply to the chosen source, operation and format. */
  private layout(): void {
    const s = this.st;
    for (const p of this.root.querySelectorAll<HTMLElement>('[data-pg-panel]')) p.hidden = p.dataset.pgPanel !== s.source;
    for (const g of this.root.querySelectorAll<HTMLElement>('[data-pg-group]')) g.hidden = g.dataset.pgGroup !== s.op;
    const f = this.formats.find((x) => x.id === s.format);
    const render = this.q('[data-pg-group="render"]');
    for (const key of FORMAT_OPTIONS) {
      const el = render.querySelector<HTMLElement>(`[data-pg-opt="${key}"]`);
      if (el) el.hidden = !f || !optionApplies(f, key, s);
    }
    this.q('[data-pg-format-help]').textContent = f?.description ?? '';
    this.q('[data-pg-opt="targetSec"]').hidden = s.by !== 'time';
    const cleanOn = s.clean || s.op === 'clean';
    for (const k of ['tags', 'quotes', 'sentences', 'fillers']) this.field(k).disabled = !cleanOn;
    this.field('clean').disabled = s.op === 'clean';
  }

  private saveHash(): void {
    const h = encodeHash(this.st, this.defaults);
    this.written = h;
    if (h) history.replaceState(history.state, '', h);
    else if (location.hash.startsWith(HASH_PREFIX)) history.replaceState(history.state, '', location.pathname + location.search);
  }

  private onHash(): void {
    if (!location.hash.startsWith(HASH_PREFIX) || location.hash === this.written) return;
    const s = decodeHash(location.hash, this.defaults);
    if (!s) return;
    const sourceChanged =
      s.source !== this.st.source || s.fixture !== this.st.fixture || s.url !== this.st.url || s.server !== this.st.server;
    const codeChanged = s.code !== this.st.code;
    this.st = this.valid(s);
    this.written = location.hash;
    this.write(this.st);
    this.layout();
    const after = sourceChanged ? this.loadSource(true) : Promise.resolve(this.scheduleOp(0));
    void after.then(() => {
      if (codeChanged) void this.runSnippet();
    });
  }

  private bind(): void {
    // Every control fires `input` (selects, checkboxes and radios too); typing waits a moment.
    this.root.addEventListener('input', (e) => {
      const t = e.target as HTMLElement;
      const name = t.dataset.pgField;
      if (!name || name === 'paste' || name === 'secondary' || name === 'starter') return;
      this.st = this.read();
      this.layout();
      this.saveHash();
      if (name === 'source' || name === 'fixture') void this.loadSource(false);
      else if (name !== 'url' && name !== 'server') {
        const typing = t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'number');
        this.scheduleOp(typing ? 150 : 0);
      }
    });

    let pasteTimer: ReturnType<typeof setTimeout> | undefined;
    this.field('paste').addEventListener('input', () => {
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => void this.loadSource(false), 250);
    });
    let secondTimer: ReturnType<typeof setTimeout> | undefined;
    this.field('secondary').addEventListener('input', () => {
      clearTimeout(secondTimer);
      secondTimer = setTimeout(() => this.readSecondary(), 250);
    });

    this.q('[data-pg-fill]').addEventListener('click', async () => {
      const load = fixtures.get(this.st.fixture);
      if (!load) return;
      this.field('paste').value = await load();
      void this.loadSource(false);
    });
    this.q('[data-pg-fetch]').addEventListener('click', () => void this.fetchContext());
    for (const name of ['url', 'server']) {
      this.field(name).addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          e.preventDefault();
          void this.fetchContext();
        }
      });
    }

    const code = this.q<HTMLTextAreaElement>('[data-pg-code]');
    code.addEventListener('input', () => {
      this.st = { ...this.st, code: code.value };
      this.saveHash();
    });
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.runSnippet();
      }
    });
    const starter = this.field('starter') as HTMLSelectElement;
    starter.addEventListener('change', () => {
      const s = STARTERS.find((x) => x.id === starter.value);
      if (!s) return;
      this.setCode(s.code);
      void this.runSnippet();
    });
    this.q('[data-pg-to-editor]').addEventListener('click', () => {
      if (!this.current) return;
      starter.value = '';
      this.setCode(this.current.code);
      code.focus();
      void this.runSnippet();
    });
    this.q('[data-pg-run]').addEventListener('click', () => void this.runSnippet());
    this.q('[data-pg-share]').addEventListener('click', () => void this.share());

    for (const kind of ['op', 'snippet'] as const) {
      this.q(`[data-pg-copy="${kind}"]`).addEventListener(
        'click',
        (e) => void this.copy(kind, e.currentTarget as HTMLButtonElement),
      );
      this.q(`[data-pg-download="${kind}"]`).addEventListener('click', () => this.download(kind));
    }
  }

  private setCode(text: string): void {
    this.q<HTMLTextAreaElement>('[data-pg-code]').value = text;
    this.st = { ...this.st, code: text };
    this.saveHash();
  }

  // ---------------------------------------------------------------- context

  private sourceError(text: string | null): void {
    const el = this.q('[data-pg-source-error]');
    el.textContent = text ?? '';
    el.hidden = !text;
  }

  private summary(text: string): void {
    this.q('[data-pg-summary]').textContent = text;
  }

  private async loadSource(auto: boolean): Promise<void> {
    const ticket = ++this.sourceSeq;
    this.sourceError(null);
    if (this.st.source === 'fixture') {
      const load = fixtures.get(this.st.fixture);
      if (!load) return;
      const raw = await load();
      if (ticket !== this.sourceSeq) return;
      await this.setContext(JSON.parse(raw) as Context);
      return;
    }
    if (this.st.source === 'paste') {
      const raw = this.field('paste').value.trim();
      if (!raw) {
        this.clearContext('Paste a VideoContext to start, or press Start from the fixture.');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        this.clearContext('The pasted text is not a VideoContext yet.');
        this.sourceError(`Not valid JSON: ${(err as Error).message}`);
        return;
      }
      const problem = contextProblem(parsed);
      if (problem) {
        this.clearContext('The pasted text is not a VideoContext yet.');
        this.sourceError(problem);
        return;
      }
      await this.setContext(parsed as Context);
      return;
    }
    if (auto && this.st.url.trim()) await this.fetchContext();
    else this.clearContext('Enter a video URL and press Fetch.');
  }

  private async fetchContext(): Promise<void> {
    const ticket = ++this.sourceSeq;
    this.sourceError(null);
    const video = this.st.url.trim();
    if (!video) {
      this.sourceError('Enter a video URL first.');
      return;
    }
    const custom = this.st.server.trim().replace(/\/+$/, '');
    let base = location.origin;
    if (custom) {
      try {
        const u = new URL(custom);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
        base = custom;
      } catch {
        this.sourceError(`Server URL must start with http:// or https://, for example http://127.0.0.1:8787.`);
        return;
      }
    }
    const button = this.q<HTMLButtonElement>('[data-pg-fetch]');
    button.disabled = true;
    this.summary(`Fetching the context from ${base}. A video without a cached copy can take a while.`);
    try {
      let res: Response;
      try {
        res = await fetch(`${base}/api/v1/context?url=${encodeURIComponent(video)}`, { headers: { accept: 'application/json' } });
      } catch {
        if (ticket !== this.sourceSeq) return;
        this.clearContext('No context loaded.');
        this.sourceError(unreachable(base, Boolean(custom)));
        return;
      }
      const text = await res.text();
      if (ticket !== this.sourceSeq) return;
      if (!res.ok) {
        this.clearContext('No context loaded.');
        const api = presentApiError(res.status, text);
        if (api) this.sourceError(api);
        else if (/^\s*</.test(text))
          this.sourceError(
            unreachable(base, Boolean(custom)).replace(
              /^No API answered at [^\n]+/,
              `${base} answered HTTP ${res.status} with a web page, not the API.`,
            ),
          );
        else this.sourceError(`HTTP ${res.status}\n${text.slice(0, 2000)}`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.clearContext('No context loaded.');
        this.sourceError(`${base} answered with something other than JSON. Is it a vid2context server?`);
        return;
      }
      const problem = contextProblem(parsed);
      if (problem) {
        this.clearContext('No context loaded.');
        this.sourceError(`The response is not a VideoContext: ${problem}`);
        return;
      }
      await this.setContext(parsed as Context);
    } finally {
      button.disabled = false;
    }
  }

  private clearContext(message: string): void {
    this.context = null;
    this.summary(message);
    this.fillChapters([]);
    this.scheduleOp(0);
  }

  private async setContext(c: Context): Promise<void> {
    this.context = c;
    this.summary(contextSummary(c));
    const res = await this.runOp({
      code: 'return core.transcriptOutline(context).sections.map(({ index, title, tokens }) => ({ index, title, tokens }));',
      wantValue: true,
    });
    if (this.context !== c) return;
    const sections =
      res.ok && 'value' in res && Array.isArray(res.value)
        ? (res.value as { index: number; title: string; tokens: number }[])
        : [];
    this.fillChapters(sections);
    this.scheduleOp(0);
  }

  private fillChapters(sections: { index: number; title: string; tokens: number }[]): void {
    const sel = this.field('chapter') as HTMLSelectElement;
    const want = this.st.chapter;
    sel.replaceChildren(new Option('Whole video', ''));
    for (const s of sections)
      sel.add(new Option(`${s.index}: ${s.title} (${s.tokens.toLocaleString('en-US')} tokens)`, String(s.index)));
    if (want && !sections.some((s) => String(s.index) === want)) sel.add(new Option(`Section ${want}`, want));
    sel.value = want;
  }

  private readSecondary(): void {
    const raw = this.field('secondary').value.trim();
    const el = this.q('[data-pg-secondary-error]');
    const fail = (msg: string) => {
      this.secondary = undefined;
      el.textContent = msg;
      el.hidden = false;
      this.scheduleOp(0);
    };
    el.hidden = true;
    if (!raw) {
      this.secondary = undefined;
      this.scheduleOp(0);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      fail(`Not valid JSON: ${(err as Error).message}`);
      return;
    }
    const { transcript, problem } = secondaryFrom(parsed);
    if (problem) {
      fail(problem);
      return;
    }
    this.secondary = transcript;
    this.scheduleOp(0);
  }

  // ---------------------------------------------------------------- running

  private runOp(req: Omit<RunRequest, 'id' | 'context' | 'secondary'>): Promise<Outcome> {
    this.opsWorker ??= newWorker();
    const worker = this.opsWorker;
    return ask(worker, { ...req, id: ++this.seq, context: this.context, secondary: this.secondary }, OP_TIMEOUT_MS, () => {
      worker.terminate();
      if (this.opsWorker === worker) this.opsWorker = null;
    });
  }

  private scheduleOp(delay: number): void {
    clearTimeout(this.opTimer);
    this.opTimer = setTimeout(() => void this.op(), delay);
  }

  private async op(): Promise<void> {
    const ticket = ++this.opSeq;
    const callEl = this.q('[data-pg-call] code');
    let gen: OpCode;
    try {
      gen = opCode(this.st, this.formats, this.secondary !== undefined);
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      this.current = null;
      this.show('op', null, err.message, 'Check the fields');
      return;
    }
    this.current = gen;
    callEl.textContent = gen.code;
    if (!this.context) {
      this.show('op', null, '', 'No context loaded');
      return;
    }
    this.status('op', 'Running');
    const res = await this.runOp({ code: gen.code });
    if (ticket !== this.opSeq) return;
    const label = this.st.op === 'render' ? this.st.format : (OPS.find((o) => o.id === this.st.op)?.label ?? this.st.op);
    this.present('op', res, label, gen);
  }

  private async runSnippet(): Promise<void> {
    const code = this.q<HTMLTextAreaElement>('[data-pg-code]').value;
    if (!this.context) {
      this.show('snippet', null, 'Load a context first: pick a fixture, paste JSON or fetch one.', 'No context loaded');
      return;
    }
    const run = this.q<HTMLButtonElement>('[data-pg-run]');
    run.disabled = true;
    this.status('snippet', 'Running');
    // A fresh worker for every run: nothing the code changes in core or the worker outlives it.
    const worker = newWorker();
    try {
      const res = await ask(
        worker,
        { id: ++this.seq, code, context: this.context, secondary: this.secondary },
        SNIPPET_TIMEOUT_MS,
        () => worker.terminate(),
      );
      this.present('snippet', res, 'Result');
    } finally {
      worker.terminate();
      run.disabled = false;
    }
  }

  private status(kind: 'op' | 'snippet', text: string): void {
    this.q(`[data-pg-status="${kind}"]`).textContent = text;
  }

  private show(kind: 'op' | 'snippet', ok: Shown | null, text: string, status: string): void {
    const pre = this.q(`[data-pg-output="${kind}"]`);
    pre.classList.toggle('pg-is-error', !ok && Boolean(text));
    pre.replaceChildren(Object.assign(document.createElement('code'), { textContent: text }));
    this.shown[kind] = ok;
    this.status(kind, status);
  }

  private present(kind: 'op' | 'snippet', res: Outcome, label: string, gen?: OpCode): void {
    const logs = 'logs' in res && res.logs.length ? `${res.logs.join('\n')}\n\n` : '';
    if (!res.ok) {
      const msg = 'stopped' in res ? res.stopped : presentRunError(res.error);
      const name = 'stopped' in res ? 'Stopped' : `Error: ${res.error.name}`;
      this.show(kind, null, `${logs}${msg}`, name);
      return;
    }
    const ms = `${Math.max(1, Math.round(res.ms))} ms`;
    if (res.kind === 'empty') {
      this.show(kind, null, logs || 'The code returned undefined. Add a return statement.', `Returned nothing, ${ms}`);
      return;
    }
    const json = res.kind === 'json';
    const shown: Shown = gen
      ? { text: res.text, extension: gen.extension, mimeType: gen.mimeType }
      : { text: res.text, extension: json ? 'json' : 'txt', mimeType: json ? 'application/json' : 'text/plain; charset=utf-8' };
    this.show(kind, shown, `${logs}${res.text}`, '');
    const what = gen ? label : `${label} (${json ? 'JSON' : 'text'})`;
    this.status(
      kind,
      `${what}: ${res.text.length.toLocaleString('en-US')} characters, about ${res.tokens.toLocaleString('en-US')} tokens, ${ms}`,
    );
  }

  // ---------------------------------------------------------------- output actions

  private async copy(kind: 'op' | 'snippet', button: HTMLButtonElement): Promise<void> {
    const text = this.shown[kind]?.text ?? this.q(`[data-pg-output="${kind}"]`).textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1800);
  }

  private download(kind: 'op' | 'snippet'): void {
    const shown = this.shown[kind];
    const text = shown?.text ?? this.q(`[data-pg-output="${kind}"]`).textContent ?? '';
    const ext = shown?.extension ?? 'txt';
    const name = `${slug(this.context?.metadata.title ?? 'output')}${kind === 'snippet' ? '-code' : ''}.${ext}`;
    const url = URL.createObjectURL(new Blob([text], { type: shown?.mimeType ?? 'text/plain; charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  private async share(): Promise<void> {
    this.st = this.read();
    this.saveHash();
    const status = this.q('[data-pg-share-status]');
    const notes: string[] = [];
    if (this.st.source === 'paste') notes.push('pasted JSON is not in links');
    if (this.secondary !== undefined) notes.push('the second transcript is not in links');
    try {
      await navigator.clipboard.writeText(location.href);
      status.textContent = `Link copied${notes.length ? ` (${notes.join('; ')})` : ''}.`;
    } catch {
      status.textContent = 'Copy the address bar: it holds this run.';
    }
  }
}

for (const el of document.querySelectorAll<HTMLElement>('[data-pg]')) new Playground(el);
