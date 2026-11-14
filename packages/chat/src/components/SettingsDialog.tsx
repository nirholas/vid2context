/**
 * Settings: the connection (API base, server API key, or client-only mode),
 * provider keys for client-only mode with a plain warning about where they
 * are kept, the theme, and the keyboard shortcuts.
 */
import { KeyRound, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Theme } from '../lib/settings.ts';
import { loadProviderKeys, loadServerApiKey } from '../lib/store.ts';
import { Button, Dialog } from './ui.tsx';

export interface KeyField {
  name: string;
  /** Services this key unlocks, e.g. "Groq". */
  unlocks: string;
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  mode: 'server' | 'client';
  apiBase: string;
  keyFields: KeyField[];
  theme: Theme;
  onTheme: (t: Theme) => void;
  onSaveConnection: (apiBase: string, serverApiKey: string) => Promise<void>;
  onSaveKeys: (keys: Record<string, string>) => Promise<void>;
  /** Open scrolled to this section ("Manage providers" in the model picker opens the keys). */
  section?: 'keys';
}

const inputClass =
  'w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent';

export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Ctrl+Shift+O (Cmd+Shift+O)', action: 'New chat' },
  { keys: '/ or Shift+Esc', action: 'Focus the message box' },
  { keys: 'Alt+M', action: 'Open the model picker' },
  { keys: 'Esc', action: 'Stop the answer, or close a panel' },
  { keys: 'Enter / Shift+Enter', action: 'Send / new line' },
  { keys: 'Alt+S (in the picker)', action: 'Star the highlighted model' },
];

export function SettingsDialog(props: SettingsDialogProps) {
  const [base, setBase] = useState(props.apiBase);
  const [serverKey, setServerKey] = useState('');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (!props.open) return;
    setBase(props.apiBase);
    setStatus('');
    setError('');
    loadProviderKeys()
      .then(setKeys)
      .catch(() => setKeys({}));
    loadServerApiKey()
      .then(setServerKey)
      .catch(() => setServerKey(''));
  }, [props.open, props.apiBase]);

  const keylessOff = keys.VID2CONTEXT_KEYLESS === '0';
  const keysRef = useRef<HTMLElement>(null);

  // Runs after the dialog's own first-field focus, so the keys section wins when asked for.
  useEffect(() => {
    if (!props.open || props.section !== 'keys') return;
    const node = keysRef.current;
    node?.scrollIntoView?.({ block: 'start' });
    node?.querySelector<HTMLElement>('input,button,a[href]')?.focus();
  }, [props.open, props.section]);

  return (
    <Dialog open={props.open} title="Settings" onClose={props.onClose} wide>
      <section aria-labelledby="set-conn" className="mb-6">
        <h3 id="set-conn" className="mb-1 text-sm font-semibold">
          Connection
        </h3>
        <p className="mb-3 text-sm text-muted">
          {props.mode === 'server'
            ? `Connected to the vid2context API at ${props.apiBase}.`
            : 'Client-only mode: no vid2context server answered, so this browser calls the models directly with your keys.'}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-muted">API base URL</span>
            <input
              className={`${inputClass} font-mono`}
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="/api/v1"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Server API key (when the server requires one)</span>
            <input
              className={`${inputClass} font-mono`}
              type="password"
              autoComplete="off"
              value={serverKey}
              onChange={(e) => setServerKey(e.target.value)}
            />
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            onClick={async () => {
              setError('');
              try {
                await props.onSaveConnection(base, serverKey);
                setStatus('Connection saved. Reconnected.');
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Save and reconnect
          </Button>
        </div>
      </section>

      <section ref={keysRef} aria-labelledby="set-keys" className="mb-6 scroll-mt-4">
        <h3 id="set-keys" className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <KeyRound size={15} aria-hidden /> Provider keys for client-only mode
        </h3>
        <div className="mb-3 flex gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          <p>
            Keys stay in this browser's storage (IndexedDB, database v2c-settings) and are sent only to the provider each key
            belongs to, never to a vid2context server. Anyone who can use this browser profile can read them. Use free-tier keys,
            and remove them on shared computers.
          </p>
        </div>
        {props.mode === 'server' ? (
          <p className="mb-3 text-sm text-muted">
            The server uses its own keys in server mode; these are used only when no server answers.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {props.keyFields.map((f) => (
            <label key={f.name} className="block text-sm">
              <span className="mb-1 flex justify-between gap-2 text-muted">
                <span className="font-mono">{f.name}</span>
                <span className="truncate">{f.unlocks}</span>
              </span>
              <input
                className={`${inputClass} font-mono`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keys[f.name] ?? ''}
                onChange={(e) => setKeys({ ...keys, [f.name]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!keylessOff}
            onChange={(e) => {
              const next = { ...keys };
              if (e.target.checked) delete next.VID2CONTEXT_KEYLESS;
              else next.VID2CONTEXT_KEYLESS = '0';
              setKeys(next);
            }}
          />
          Allow keyless models (free, no account; your questions and the transcripts go to those hosts)
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={async () => {
              setKeys({});
              await props.onSaveKeys({});
              setStatus('Keys removed from this browser.');
            }}
          >
            Remove all keys
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              setError('');
              try {
                await props.onSaveKeys(keys);
                setStatus('Keys saved in this browser.');
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Save keys
          </Button>
        </div>
      </section>

      <section aria-labelledby="set-theme" className="mb-6">
        <h3 id="set-theme" className="mb-2 text-sm font-semibold">
          Theme
        </h3>
        <div role="radiogroup" aria-labelledby="set-theme" className="flex gap-2">
          {(['dark', 'light', 'system'] as Theme[]).map((t) => (
            <label
              key={t}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-sm has-[:checked]:border-accent"
            >
              <input
                type="radio"
                name="v2c-theme"
                value={t}
                checked={props.theme === t}
                onChange={() => props.onTheme(t)}
                className="accent-[var(--v2c-accent)]"
              />
              {t[0]?.toUpperCase()}
              {t.slice(1)}
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="set-keys-sc">
        <h3 id="set-keys-sc" className="mb-2 text-sm font-semibold">
          Keyboard shortcuts
        </h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="contents">
              <dt className="font-mono text-xs text-muted">{s.keys}</dt>
              <dd>{s.action}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="mt-4 min-h-5 text-sm" role="status">
        {error ? <span className="text-danger">{error}</span> : status}
      </p>
    </Dialog>
  );
}
