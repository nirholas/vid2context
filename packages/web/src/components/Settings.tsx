/**
 * Settings: API base (localStorage v2c.apiBase), theme (v2c.theme) and
 * provider keys for client-only mode (IndexedDB v2c-settings / kv / providerKeys).
 */
import { CircleCheck, Monitor, Moon, Plus, Sun, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { apiBase, DEFAULT_API_BASE, getHealth, normalizeApiBase, setApiBase } from '../lib/api.ts';
import { useApiStatus } from '../lib/api-status.tsx';
import { cleanKeys, KEY_NAME, loadProviderKeys, saveProviderKeys } from '../lib/settings.ts';
import { loadTheme, saveTheme, type Theme } from '../lib/theme.ts';
import { ErrorPanel } from './ErrorPanel.tsx';
import { Button, Card, Spinner } from './ui.tsx';

/**
 * Env names the browser's speech-to-text rungs read, from the browser
 * registry itself, so the suggestions match what the code actually uses.
 * Any env-style name can still be saved.
 */
export async function sttKeyNames(): Promise<string[]> {
  const { createRegistry } = await import('@vid2context/registry/browser');
  const names = new Set<string>();
  for (const p of createRegistry().health({})) {
    if (p.kind !== 'stt') continue;
    for (const r of p.rungs ?? []) for (const n of r.requires) names.add(n);
  }
  names.add('TRANSFORMERS_DEVICE');
  return [...names].sort();
}

function ApiSection() {
  const { state, recheck } = useApiStatus();
  const [value, setValue] = useState(apiBase());
  const [test, setTest] = useState<{ status: 'idle' | 'testing' | 'ok' | 'error'; detail?: string; error?: unknown }>({ status: 'idle' });
  const id = useId();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setApiBase(value);
    setValue(apiBase());
    setTest({ status: 'testing' });
    try {
      const h = await getHealth(AbortSignal.timeout(8000), normalizeApiBase(value) || DEFAULT_API_BASE);
      setTest({ status: 'ok', detail: `${h.name} ${h.version} on ${h.runtime}, ${h.formats.length} formats` });
    } catch (err) {
      setTest({ status: 'error', error: err });
    }
    await recheck();
  };
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="text-base font-semibold text-fg">API server</h2>
        <p className="text-sm text-muted">
          Where the app fetches links. Default: <code className="font-mono">{DEFAULT_API_BASE}</code>. Stored in this browser only.
        </p>
      </div>
      <form onSubmit={save} className="space-y-2">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          API base
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={id}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={DEFAULT_API_BASE}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-v2c-sm border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-fg placeholder:text-muted"
            aria-describedby={`${id}-hint`}
          />
          <Button type="submit" variant="accent">
            Save and test
          </Button>
        </div>
        <p id={`${id}-hint`} className="text-xs text-muted">
          For example http://127.0.0.1:8787/api/v1 for a server on this machine. The server must allow this site in
          VID2CONTEXT_CORS_ORIGINS when it runs on another origin. Leave empty for the default.
        </p>
      </form>
      <p className="text-sm text-muted" role="status">
        {test.status === 'testing' && (
          <span className="flex items-center gap-2">
            <Spinner /> Testing
          </span>
        )}
        {test.status === 'ok' && (
          <span className="flex items-center gap-2 text-fg">
            <CircleCheck className="size-4 text-success" aria-hidden /> Connected: {test.detail}
          </span>
        )}
        {test.status === 'idle' &&
          (state.status === 'online'
            ? `Connected to ${state.base} (${state.health.name} ${state.health.version}).`
            : state.status === 'checking'
              ? 'Checking the connection.'
              : state.status === 'client-only-build'
                ? 'This copy is built for client-only use. Save an API base to use a server.'
                : `No API answered at ${state.base}. The app is in client-only mode.`)}
      </p>
      {test.status === 'error' && <ErrorPanel title="The API did not answer" error={test.error} />}
    </Card>
  );
}

const THEME_OPTIONS: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'system', label: 'System', icon: Monitor },
];

function ThemeSection() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  return (
    <Card className="space-y-3 p-5">
      <fieldset>
        <legend className="text-base font-semibold text-fg">Theme</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {THEME_OPTIONS.map((t) => (
            <label
              key={t.id}
              className={`flex cursor-pointer items-center gap-2 rounded-v2c border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                theme === t.id ? 'border-accent bg-surface-2 text-fg' : 'border-border text-muted hover:text-fg'
              }`}
            >
              <input
                type="radio"
                name="theme"
                value={t.id}
                checked={theme === t.id}
                onChange={() => {
                  setTheme(t.id);
                  saveTheme(t.id);
                }}
                className="sr-only"
              />
              <t.icon className="size-4" aria-hidden />
              {t.label}
            </label>
          ))}
        </div>
      </fieldset>
    </Card>
  );
}

interface KeyRow {
  id: number;
  name: string;
  value: string;
}

function KeysSection() {
  const [rows, setRows] = useState<KeyRow[]>();
  const [status, setStatus] = useState<{ kind: 'idle' | 'saved' | 'error'; text?: string }>({ kind: 'idle' });
  const [nextId, setNextId] = useState(1);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();

  useEffect(() => {
    sttKeyNames().then(setSuggestions, (err) => console.error('[vid2context] could not list provider key names', err));
  }, []);

  useEffect(() => {
    loadProviderKeys().then(
      (keys) => {
        const list = Object.entries(keys).map(([name, value], i) => ({ id: i + 1, name, value }));
        setRows(list.length ? list : [{ id: list.length + 1, name: '', value: '' }]);
        setNextId(list.length + 2);
      },
      (err) => {
        setRows([]);
        setStatus({ kind: 'error', text: `This browser's IndexedDB is unavailable, so keys cannot be stored: ${String(err?.message ?? err)}` });
      },
    );
  }, []);

  if (!rows) {
    return (
      <Card className="p-5">
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner /> Loading saved keys
        </p>
      </Card>
    );
  }

  const invalid = rows.filter((r) => r.name.trim() && !KEY_NAME.test(r.name.trim().toUpperCase()));
  const update = (id: number, patch: Partial<KeyRow>) => {
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setStatus({ kind: 'idle' });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid.length) return;
    try {
      const keys = cleanKeys(rows);
      await saveProviderKeys(keys);
      setStatus({ kind: 'saved', text: `Saved ${Object.keys(keys).length} value${Object.keys(keys).length === 1 ? '' : 's'}.` });
    } catch (err) {
      setStatus({ kind: 'error', text: `Could not save: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-fg">Provider keys for client-only mode</h2>
        <p className="text-sm text-fg">
          Keys are stored in this browser's IndexedDB (database <code className="font-mono">v2c-settings</code>) and never leave this
          device except in requests to the provider each key belongs to. They are never sent to the vid2context server.
        </p>
        <p className="text-sm text-muted">
          They are used only when this app transcribes a file in your browser. No key is needed: Whisper runs locally by default.
          Use env-style names, such as <code className="font-mono">GROQ_API_KEY</code>, or{' '}
          <code className="font-mono">TRANSFORMERS_STT_MODEL</code> to pick another Whisper model.
        </p>
      </div>
      <form onSubmit={save} className="space-y-3">
        <datalist id={listId}>
          {suggestions.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <ul className="space-y-2">
          {rows.map((r, i) => {
            const bad = r.name.trim() !== '' && !KEY_NAME.test(r.name.trim().toUpperCase());
            return (
              <li key={r.id} className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <div className="min-w-0 sm:w-64">
                  <label htmlFor={`key-name-${r.id}`} className="sr-only">
                    Name {i + 1}
                  </label>
                  <input
                    id={`key-name-${r.id}`}
                    list={listId}
                    value={r.name}
                    onChange={(e) => update(r.id, { name: e.target.value })}
                    placeholder="GROQ_API_KEY"
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={bad || undefined}
                    className="w-full rounded-v2c-sm border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-fg placeholder:text-muted"
                  />
                  {bad && <p className="mt-1 text-xs text-fg">Use letters, digits and underscores, starting with a letter.</p>}
                </div>
                <div className="min-w-0 flex-1">
                  <label htmlFor={`key-value-${r.id}`} className="sr-only">
                    Value {i + 1}
                  </label>
                  <input
                    id={`key-value-${r.id}`}
                    type="password"
                    value={r.value}
                    onChange={(e) => update(r.id, { value: e.target.value })}
                    placeholder="Value"
                    autoComplete="off"
                    className="w-full rounded-v2c-sm border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-fg placeholder:text-muted"
                  />
                </div>
                <Button
                  variant="ghost"
                  aria-label={`Remove ${r.name || `row ${i + 1}`}`}
                  onClick={() => setRows((rs) => rs?.filter((x) => x.id !== r.id))}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              setRows((rs) => [...(rs ?? []), { id: nextId, name: '', value: '' }]);
              setNextId((n) => n + 1);
            }}
          >
            <Plus className="size-4" aria-hidden /> Add a key
          </Button>
          <Button type="submit" variant="accent" disabled={invalid.length > 0}>
            Save keys
          </Button>
          <span className="text-sm text-muted" role="status">
            {status.text}
          </span>
        </div>
      </form>
    </Card>
  );
}

export function Settings() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold text-fg">Settings</h1>
      <ApiSection />
      <ThemeSection />
      <KeysSection />
    </div>
  );
}

export default Settings;
