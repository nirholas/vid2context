/**
 * Makes the runnable examples on a docs page live. Each `[data-rx]` block was
 * rendered at build time with its spec, the snippets for the default values
 * and a recorded response; this script rebuilds the snippets as you edit,
 * runs the request against the chosen server, and shows the response.
 *
 * Settings shared by every block: the server (this site, a local server, or a
 * custom URL) in localStorage, and an optional API key in sessionStorage only.
 */
import {
  buildRequest,
  formatDuration,
  highlightCode,
  InputError,
  presentSse,
  presentText,
  presentZip,
  requestUrl,
  type RunnableSpec,
  SHOWN_HEADERS,
  STATUS_TEXT,
  type SnippetOptions,
  snippets,
  type Values,
} from '../lib/runnable.ts';

// ------------------------------------------------------------------ settings

type ServerMode = 'site' | 'local' | 'custom';
interface Settings {
  mode: ServerMode;
  custom: string;
}

const LOCAL = 'http://127.0.0.1:8787';
const SETTINGS_KEY = 'v2c.run.server';
const KEY_KEY = 'v2c.run.key';
const BASE_PATH = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const CLI_PREFIX = document.querySelector<HTMLElement>('[data-rx-cli]')?.dataset.rxCli ?? 'npx -y vid2context';

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    if (raw && (raw.mode === 'site' || raw.mode === 'local' || raw.mode === 'custom')) {
      return { mode: raw.mode, custom: typeof raw.custom === 'string' ? raw.custom : '' };
    }
  } catch {
    // Storage can be unavailable (private mode); the defaults apply.
  }
  return { mode: 'site', custom: '' };
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Not persisted; the choice still applies to this page.
  }
}

function loadKey(): string {
  try {
    return sessionStorage.getItem(KEY_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveKey(key: string): void {
  try {
    if (key) sessionStorage.setItem(KEY_KEY, key);
    else sessionStorage.removeItem(KEY_KEY);
  } catch {
    // Kept in memory for this page only.
  }
}

let settings = loadSettings();
let apiKey = loadKey();

function baseUrl(s: Settings = settings): string {
  if (s.mode === 'local') return LOCAL;
  if (s.mode === 'custom' && s.custom) return s.custom.replace(/\/+$/, '');
  return location.origin;
}

function serverLabel(s: Settings = settings): string {
  if (s.mode === 'site') return location.host;
  return baseUrl(s).replace(/^https?:\/\//, '');
}

function snippetOptions(): SnippetOptions {
  return { base: baseUrl(), auth: Boolean(apiKey), cliPrefix: CLI_PREFIX };
}

/** Headers every request sends. */
function authHeaders(): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

// ------------------------------------------------------------------ health

type Health = { state: 'idle' | 'checking' } | { state: 'ok'; text: string } | { state: 'down'; text: string };
let health: Health = { state: 'idle' };
let healthRun = 0;

async function checkHealth(): Promise<void> {
  const run = ++healthRun;
  health = { state: 'checking' };
  broadcast();
  try {
    const res = await fetch(`${baseUrl()}/api/v1/health`, { headers: authHeaders(), signal: AbortSignal.timeout(6000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('json')) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { name?: string; version?: string; runtime?: string };
    if (run !== healthRun) return;
    health = { state: 'ok', text: `online, ${body.name ?? 'vid2context'} ${body.version ?? ''} (${body.runtime ?? 'server'})` };
  } catch {
    if (run !== healthRun) return;
    health = { state: 'down', text: 'not reachable' };
  }
  broadcast();
}

// ------------------------------------------------------------------ shared values between blocks

const provided = new Map<string, string>();
const blocks: Block[] = [];

function broadcast(): void {
  for (const b of blocks) b.syncServer();
}

// ------------------------------------------------------------------ settings dialog

const dialog = document.querySelector<HTMLDialogElement>('#rx-settings');

function openSettings(focus: 'url' | 'key' = 'url'): void {
  if (!dialog) return;
  const form = dialog.querySelector('form');
  const urlInput = dialog.querySelector<HTMLInputElement>('[name="server-url"]');
  const keyInput = dialog.querySelector<HTMLInputElement>('[name="api-key"]');
  const origin = dialog.querySelector<HTMLElement>('[data-rx-origin]');
  if (!form || !urlInput || !keyInput) return;
  urlInput.value = settings.mode === 'custom' ? settings.custom : settings.mode === 'local' ? LOCAL : '';
  keyInput.value = apiKey;
  if (origin) origin.textContent = location.origin;
  dialog.showModal();
  (focus === 'key' ? keyInput : urlInput).focus();
}

if (dialog) {
  const form = dialog.querySelector('form');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const urlInput = dialog.querySelector<HTMLInputElement>('[name="server-url"]');
    const keyInput = dialog.querySelector<HTMLInputElement>('[name="api-key"]');
    const error = dialog.querySelector<HTMLElement>('[data-rx-settings-error]');
    const raw = urlInput?.value.trim() ?? '';
    let next: Settings = { mode: 'site', custom: settings.custom };
    if (raw) {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        if (error) {
          error.textContent = 'Enter a full URL such as http://127.0.0.1:8787, or leave it empty for this site.';
          error.hidden = false;
        }
        return;
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        if (error) {
          error.textContent = 'Use an http or https URL.';
          error.hidden = false;
        }
        return;
      }
      const clean = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
      next = clean === LOCAL ? { mode: 'local', custom: settings.custom } : clean === location.origin ? next : { mode: 'custom', custom: clean };
    }
    if (error) error.hidden = true;
    apiKey = keyInput?.value.trim() ?? '';
    saveKey(apiKey);
    settings = next;
    saveSettings(settings);
    dialog.close();
    void checkHealth();
    for (const b of blocks) b.refresh();
  });
  dialog.querySelector('[data-rx-settings-cancel]')?.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-rx-settings-reset]')?.addEventListener('click', () => {
    const urlInput = dialog.querySelector<HTMLInputElement>('[name="server-url"]');
    const keyInput = dialog.querySelector<HTMLInputElement>('[name="api-key"]');
    if (urlInput) urlInput.value = '';
    if (keyInput) keyInput.value = '';
  });
}

// ------------------------------------------------------------------ one block

const fmtSec = formatDuration;

function filenameFrom(disposition: string | null, fallback: string): string {
  const m = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return m?.[1] ? decodeURIComponent(m[1]) : fallback;
}

interface ErrorBody {
  error?: { code?: string; message?: string; hint?: string };
  attempts?: { stage: string; id: string; outcome: string; reason?: string; detail?: string }[];
}

function presentError(status: number, text: string): string {
  let body: ErrorBody | null = null;
  try {
    body = JSON.parse(text) as ErrorBody;
  } catch {
    return text;
  }
  if (!body?.error) return JSON.stringify(body, null, 2);
  const lines = [`${body.error.code}: ${body.error.message}`];
  if (body.error.hint) lines.push(`hint: ${body.error.hint}`);
  if (body.attempts?.length) {
    lines.push('', 'Attempts:');
    for (const a of body.attempts) {
      lines.push(`  ${a.stage.padEnd(9)}${a.outcome.padEnd(8)}${a.id}${a.reason ? `  ${a.reason}` : ''}${a.detail ? `  ${a.detail}` : ''}`);
    }
  }
  lines.push('', JSON.stringify(body, null, 2));
  return `HTTP ${status}\n${lines.join('\n')}`;
}

class Block {
  readonly el: HTMLElement;
  readonly spec: RunnableSpec;
  private readonly form: HTMLFormElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly server: HTMLSelectElement;
  private readonly healthEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly clipEl: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly downloadLink: HTMLAnchorElement;
  private readonly inputError: HTMLElement;
  private readonly recorded: { status: string; body: string; meta: string; clip: string; clipHidden: boolean; error: boolean };
  private live: { status: string; body: string; meta: string; error: boolean } | null = null;
  private showing: 'recorded' | 'live' = 'recorded';
  private file: File | null = null;
  private readonly edited = new Set<string>();
  private controller: AbortController | null = null;
  private downloadUrl: string | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    const specEl = el.querySelector('[data-rx-spec]');
    this.spec = JSON.parse(specEl?.textContent ?? '{}') as RunnableSpec;
    const q = <T extends Element>(sel: string) => {
      const found = el.querySelector<T>(sel);
      if (!found) throw new Error(`Runnable ${this.spec.id}: missing ${sel}`);
      return found;
    };
    this.form = q<HTMLFormElement>('form');
    this.runBtn = q<HTMLButtonElement>('[data-rx-run]');
    this.server = q<HTMLSelectElement>('[data-rx-server]');
    this.healthEl = q<HTMLElement>('[data-rx-health]');
    this.statusEl = q<HTMLElement>('[data-rx-status]');
    this.bodyEl = q<HTMLElement>('[data-rx-body]');
    this.metaEl = q<HTMLElement>('[data-rx-meta]');
    this.clipEl = q<HTMLElement>('[data-rx-clip]');
    this.toggleBtn = q<HTMLButtonElement>('[data-rx-toggle]');
    this.downloadLink = q<HTMLAnchorElement>('[data-rx-download]');
    this.inputError = q<HTMLElement>('[data-rx-input-error]');
    this.recorded = {
      status: this.statusEl.textContent ?? '',
      body: this.bodyEl.innerHTML,
      meta: this.metaEl.innerHTML,
      clip: this.clipEl.textContent ?? '',
      clipHidden: this.clipEl.hidden,
      error: this.bodyEl.classList.contains('rx-error'),
    };
    this.wire();
    this.runBtn.disabled = false;
    this.runBtn.removeAttribute('title');
    this.server.disabled = false;
    q<HTMLButtonElement>('[data-rx-settings]').disabled = false;
    this.syncServer();
    this.refresh();
  }

  private control(name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
    return this.form.querySelector(`[name="${CSS.escape(name)}"]`);
  }

  values(): Values {
    const v: Values = {};
    for (const f of this.spec.fields) {
      if (f.type === 'file') continue;
      const c = this.control(f.name);
      if (!c) continue;
      v[f.name] = c instanceof HTMLInputElement && c.type === 'checkbox' ? (c.checked ? 'true' : '') : c.value;
    }
    return v;
  }

  private setValue(name: string, value: string): void {
    const c = this.control(name);
    if (!c) return;
    if (c instanceof HTMLInputElement && c.type === 'checkbox') c.checked = value === 'true';
    else c.value = value;
  }

  private fileName(): string | undefined {
    return this.file?.name ?? this.spec.sample?.name;
  }

  private wire(): void {
    this.form.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name) this.edited.add(t.name);
      this.refresh();
    });
    this.form.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.type === 'file') {
        this.file = t.files?.[0] ?? null;
        this.setFileLabel(this.file ? `Sending: ${this.file.name} (${Math.round(this.file.size / 1024)} KB)` : undefined);
      }
      this.refresh();
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.controller) this.cancel();
      else void this.run();
    });
    this.form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (!this.controller) void this.run();
      }
    });
    this.el.querySelector('[data-rx-reset]')?.addEventListener('click', () => this.reset());
    this.el.querySelector('[data-rx-sample]')?.addEventListener('click', () => this.useSample());
    this.el.querySelector('[data-rx-settings]')?.addEventListener('click', () => openSettings());
    this.server.addEventListener('change', () => {
      const mode = this.server.value as ServerMode;
      if (mode === 'custom' && !settings.custom) {
        this.syncServer();
        openSettings();
        return;
      }
      settings = { ...settings, mode };
      saveSettings(settings);
      void checkHealth();
      for (const b of blocks) b.refresh();
    });
    this.toggleBtn.addEventListener('click', () => this.show(this.showing === 'live' ? 'recorded' : 'live'));
    const tabs = [...this.el.querySelectorAll<HTMLButtonElement>('[data-rx-tab]')];
    for (const tab of tabs) {
      tab.addEventListener('click', () => this.selectTab(tab.dataset.rxTab ?? 'curl'));
      tab.addEventListener('keydown', (e) => {
        const visible = tabs.filter((t) => !t.hidden);
        const at = visible.indexOf(tab);
        let next: HTMLButtonElement | undefined;
        if (e.key === 'ArrowRight') next = visible[(at + 1) % visible.length];
        else if (e.key === 'ArrowLeft') next = visible[(at - 1 + visible.length) % visible.length];
        else if (e.key === 'Home') next = visible[0];
        else if (e.key === 'End') next = visible[visible.length - 1];
        if (!next) return;
        e.preventDefault();
        this.selectTab(next.dataset.rxTab ?? 'curl');
        next.focus();
      });
    }
    document.addEventListener('rx:provide', (e) => {
      const { name, value } = (e as CustomEvent<{ name: string; value: string }>).detail;
      for (const f of this.spec.fields) {
        if (f.from !== name || this.edited.has(f.name)) continue;
        this.setValue(f.name, value);
        const c = this.control(f.name);
        c?.classList.add('rx-filled');
        setTimeout(() => c?.classList.remove('rx-filled'), 1600);
      }
      this.refresh();
    });
  }

  private selectTab(id: string): void {
    for (const t of this.el.querySelectorAll<HTMLButtonElement>('[data-rx-tab]')) {
      const on = t.dataset.rxTab === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const p of this.el.querySelectorAll<HTMLElement>('[data-rx-panel]')) p.hidden = p.dataset.rxPanel !== id;
  }

  private setFileLabel(text?: string): void {
    const label = this.el.querySelector<HTMLElement>('[data-rx-file-name]');
    if (label) label.textContent = text ?? (this.spec.sample ? `Sending: ${this.spec.sample.name} (sample)` : 'No file chosen');
  }

  /** Go back to the sample file (sent when no file is chosen). */
  private useSample(): void {
    if (!this.spec.sample) return;
    const input = this.el.querySelector<HTMLInputElement>('input[type="file"]');
    if (input) input.value = '';
    this.file = null;
    this.setFileLabel();
    this.refresh();
  }

  private async sampleFile(): Promise<File | null> {
    const sample = this.spec.sample;
    if (!sample) return null;
    const res = await fetch(`${BASE_PATH}${sample.href}`);
    if (!res.ok) throw new Error(`Could not load the sample file (HTTP ${res.status}).`);
    return new File([await res.blob()], sample.name, { type: res.headers.get('content-type') ?? 'audio/mpeg' });
  }

  private reset(): void {
    for (const f of this.spec.fields) {
      if (f.type === 'file') continue;
      this.setValue(f.name, f.from && provided.has(f.from) ? (provided.get(f.from) as string) : (f.default ?? ''));
    }
    this.edited.clear();
    this.file = null;
    const input = this.el.querySelector<HTMLInputElement>('input[type="file"]');
    if (input) input.value = '';
    this.setFileLabel();
    this.refresh();
  }

  syncServer(): void {
    this.server.value = settings.mode;
    const customOpt = this.server.querySelector<HTMLOptionElement>('option[value="custom"]');
    if (customOpt) customOpt.textContent = settings.custom ? `Custom: ${settings.custom.replace(/^https?:\/\//, '')}` : 'Custom URL';
    const siteOpt = this.server.querySelector<HTMLOptionElement>('option[value="site"]');
    if (siteOpt) siteOpt.textContent = `This site (${location.host})`;
    this.healthEl.dataset.state = health.state;
    this.healthEl.textContent = health.state === 'checking' ? 'checking' : health.state === 'idle' ? '' : health.text;
  }

  /** Rebuild the snippets for the current values. */
  refresh(): void {
    let list: ReturnType<typeof snippets>;
    try {
      list = snippets(this.spec, this.values(), snippetOptions(), this.fileName());
      this.inputError.hidden = true;
      this.runBtn.disabled = false;
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      this.inputError.textContent = err.message;
      this.inputError.hidden = false;
      if (!this.controller) this.runBtn.disabled = true;
      return;
    }
    const byId = new Map(list.map((s) => [s.id, s]));
    let selectedHidden = false;
    for (const tab of this.el.querySelectorAll<HTMLButtonElement>('[data-rx-tab]')) {
      const id = tab.dataset.rxTab ?? '';
      const s = byId.get(id as never);
      tab.hidden = !s;
      if (!s && tab.getAttribute('aria-selected') === 'true') selectedHidden = true;
      const panel = this.el.querySelector<HTMLElement>(`[data-rx-panel="${id}"] code`);
      if (panel && s) panel.innerHTML = highlightCode(s.code, s.lang);
    }
    if (selectedHidden) this.selectTab('curl');
  }

  private cancel(): void {
    this.controller?.abort();
  }

  private show(which: 'recorded' | 'live'): void {
    this.showing = which;
    const view = which === 'live' && this.live ? this.live : this.recorded;
    this.statusEl.textContent = view.status;
    this.bodyEl.innerHTML = view.body;
    this.metaEl.innerHTML = view.meta;
    this.bodyEl.classList.toggle('rx-error', view.error);
    this.clipEl.hidden = which === 'live' ? true : this.recorded.clipHidden;
    this.toggleBtn.hidden = !this.live;
    this.toggleBtn.textContent = which === 'live' ? 'Show recorded' : 'Show your run';
    this.downloadLink.hidden = which !== 'live' || !this.downloadUrl;
  }

  private setLive(status: string, text: string, lang: 'json' | 'text' | 'bash' | 'js' | 'python', meta: string, error = false): void {
    this.live = { status, body: `<code>${highlightCode(text, lang)}</code>`, meta, error };
    this.show('live');
  }

  private metaHtml(res: Response): string {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
    return SHOWN_HEADERS.map((h) => [h, res.headers.get(h)] as const)
      .filter(([, v]) => v !== null)
      .map(([h, v]) => `<span><b>${h}</b> ${esc(v as string)}</span>`)
      .join('');
  }

  private async run(): Promise<void> {
    let req: ReturnType<typeof buildRequest>;
    try {
      req = buildRequest(this.spec, this.values(), this.fileName());
    } catch (err) {
      if (err instanceof InputError) {
        this.inputError.textContent = err.message;
        this.inputError.hidden = false;
        return;
      }
      throw err;
    }
    const base = baseUrl();
    const url = requestUrl(base, req);
    const controller = new AbortController();
    this.controller = controller;
    const started = performance.now();
    this.runBtn.textContent = 'Cancel';
    this.runBtn.classList.add('rx-running');
    this.el.setAttribute('aria-busy', 'true');
    if (this.downloadUrl) {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
    this.live = { status: `Running against ${serverLabel()}`, body: '<code></code>', meta: '', error: false };
    this.show('live');
    const timer = setInterval(() => {
      if (this.live && this.showing === 'live' && this.live.status.startsWith('Running')) {
        this.live.status = `Running against ${serverLabel()}: ${fmtSec(performance.now() - started)}`;
        this.statusEl.textContent = this.live.status;
      }
    }, 100);
    const done = (res: Response | null) => `${res ? `${res.status} ${STATUS_TEXT[res.status] ?? ''}`.trim() : 'Failed'}, ${fmtSec(performance.now() - started)}, ${serverLabel()}`;

    try {
      const init: RequestInit = { method: req.method, headers: authHeaders(), signal: controller.signal };
      if (req.file) {
        const file = this.file ?? (await this.sampleFile());
        if (!file) throw new InputError('Choose a file first.');
        const form = new FormData();
        form.append(req.file.field, file, file.name);
        init.body = form;
      } else if (req.json) {
        init.headers = { ...authHeaders(), 'Content-Type': 'application/json' };
        init.body = JSON.stringify(req.json);
      }
      const res = await fetch(url, init);
      const type = res.headers.get('content-type') ?? '';
      const meta = this.metaHtml(res);
      if (type.includes('text/html')) {
        throw new NoApi(res.status);
      }
      if (!res.ok) {
        this.setLive(`Your run: ${done(res)}`, presentError(res.status, await res.text()), 'text', meta, true);
        return;
      }
      if (type.includes('event-stream') && res.body) {
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let text = '';
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          text += value;
          this.live = { status: this.live?.status ?? '', body: `<code>${highlightCode(presentSse(text), 'text')}</code>`, meta, error: false };
          this.bodyEl.innerHTML = this.live.body;
        }
        this.setLive(`Your run: ${done(res)}`, presentSse(text), 'text', meta);
        return;
      }
      if (type.includes('zip')) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        this.downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        this.downloadLink.href = this.downloadUrl;
        this.downloadLink.download = filenameFrom(res.headers.get('content-disposition'), `${this.spec.id}.zip`);
        this.setLive(`Your run: ${done(res)}`, presentZip(bytes), 'text', meta);
        return;
      }
      const text = await res.text();
      if (this.spec.job && res.status === 202) {
        await this.followJob(JSON.parse(text) as Job, base, controller.signal, started, meta);
        return;
      }
      const shown = presentText(type, text);
      this.setLive(`Your run: ${done(res)}`, shown.text, shown.lang === 'json' ? 'json' : 'text', meta);
      if (this.spec.provides) this.provide(text);
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') this.setLive(`Canceled after ${fmtSec(performance.now() - started)}`, 'The request was canceled.', 'text', '', true);
      else if (err instanceof InputError) this.setLive('Not sent', e.message, 'text', '', true);
      else this.setLive(`Your run: ${done(null)}`, unreachableHelp(err instanceof NoApi ? err.status : null), 'text', '', true);
    } finally {
      clearInterval(timer);
      this.controller = null;
      this.runBtn.textContent = 'Run';
      this.runBtn.classList.remove('rx-running');
      this.el.removeAttribute('aria-busy');
      this.refresh();
    }
  }

  private async followJob(first: Job, base: string, signal: AbortSignal, started: number, meta: string): Promise<void> {
    let job = first;
    while (job.status === 'queued' || job.status === 'running') {
      const progress = job.progress ? ` ${JSON.stringify(job.progress)}` : '';
      if (this.live) {
        this.live.status = `Job ${job.status}${progress}: ${fmtSec(performance.now() - started)}`;
        this.live.body = `<code>${highlightCode(JSON.stringify(job, null, 2), 'json')}</code>`;
        this.show('live');
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (signal.aborted) throw Object.assign(new Error('Canceled'), { name: 'AbortError' });
      const res = await fetch(`${base}/api/v1/jobs/${encodeURIComponent(job.id)}`, { headers: authHeaders(), signal });
      if (!res.ok) {
        this.setLive(`Job ${job.id}: HTTP ${res.status}`, presentError(res.status, await res.text()), 'text', meta, true);
        return;
      }
      job = (await res.json()) as Job;
    }
    const failed = job.status !== 'succeeded';
    this.setLive(
      `Job ${job.status}: ${fmtSec(performance.now() - started)}, ${serverLabel()}`,
      JSON.stringify(failed ? job : job.result, null, 2),
      'json',
      meta,
      failed,
    );
  }

  private provide(text: string): void {
    const p = this.spec.provides;
    if (!p) return;
    try {
      const value = p.path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), JSON.parse(text));
      if (typeof value !== 'string') return;
      provided.set(p.name, value);
      document.dispatchEvent(new CustomEvent('rx:provide', { detail: { name: p.name, value } }));
    } catch {
      // A body that is not JSON provides nothing.
    }
  }
}

interface Job {
  id: string;
  status: string;
  progress?: unknown;
  result?: unknown;
  error?: unknown;
}

class NoApi extends Error {
  constructor(readonly status: number) {
    super('No API at this address');
  }
}

function unreachableHelp(status: number | null): string {
  const base = baseUrl();
  if (settings.mode === 'site') {
    return [
      status ? `${location.origin} answered HTTP ${status} with a web page, not the API.` : `No API answered at ${location.origin}.`,
      '',
      'This copy of the docs is served without the HTTP API (for example by astro dev or a static host).',
      'Choose "Local server" and start one from a clone of the repo:',
      '',
      `  VID2CONTEXT_CORS_ORIGINS=${location.origin} npm run start:server`,
      '',
      'Or serve the docs and the API together with npm run dev:worker.',
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
    'Your browser may also ask whether this site may reach devices on your local network; allow it.',
  ].join('\n');
}

// ------------------------------------------------------------------ start

for (const el of document.querySelectorAll<HTMLElement>('[data-rx]')) blocks.push(new Block(el));
if (blocks.length && settings.mode === 'site') {
  // Same-origin only on load; a local or custom server is checked when you pick it.
  const first = blocks[0]?.el;
  if (first && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        void checkHealth();
      }
    });
    io.observe(first);
  } else void checkHealth();
}
