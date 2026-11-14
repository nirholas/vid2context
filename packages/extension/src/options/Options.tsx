import { Check, RotateCcw, ShieldCheck } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ext } from '../lib/browser.ts';
import { originPattern } from '../lib/links.ts';
import { cleanBase, DEFAULT_SETTINGS, loadSettings, type Settings, saveSettings } from '../lib/settings.ts';
import { Button } from '../ui/Button.tsx';
import { Logo } from '../ui/Logo.tsx';
import { copyFormats } from '../youtube/copy.ts';

type Draft = Settings;

function problems(d: Draft): Partial<Record<keyof Settings, string>> {
  const out: Partial<Record<keyof Settings, string>> = {};
  if (!cleanBase(d.appBase)) out.appBase = 'Enter an http or https URL.';
  if (!cleanBase(d.apiBase)) out.apiBase = 'Enter an http or https URL, ending in /api/v1.';
  if (!d.copyTemplate.includes('{{content}}')) out.copyTemplate = 'The template must contain {{content}}.';
  return out;
}

export function Options() {
  const [draft, setDraft] = useState<Draft>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState<Draft>(DEFAULT_SETTINGS);
  const [note, setNote] = useState<string | null>(null);
  const [apiAllowed, setApiAllowed] = useState<boolean | null>(null);
  const formats = useMemo(() => copyFormats(), []);
  const errors = problems(draft);
  const valid = Object.keys(errors).length === 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const apiBase = cleanBase(draft.apiBase);

  useEffect(() => {
    void loadSettings(ext.storage.sync).then((s) => {
      setDraft(s);
      setSaved(s);
    });
  }, []);

  useEffect(() => {
    if (!apiBase) return setApiAllowed(null);
    void ext.permissions.contains({ origins: [originPattern(apiBase)] }).then(setApiAllowed);
  }, [apiBase]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setNote(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = async () => {
    const clean = await saveSettings(ext.storage.sync, draft);
    setDraft(clean);
    setSaved(clean);
    setNote('Saved.');
  };

  const allowApi = () => {
    if (!apiBase) return;
    // Called straight from the click so the browser shows its permission prompt.
    void ext.permissions.request({ origins: [originPattern(apiBase)] }).then(setApiAllowed);
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center gap-3">
        <Logo size={28} />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">vid2context options</h1>
          <p className="text-sm text-muted">Saved to your browser profile and synced where your browser syncs.</p>
        </div>
      </header>

      <Section title="Where vid2context runs">
        <Field
          id="app-base"
          label="App base"
          hint="Open in vid2context and the context menu open <app base>/app/?url=..."
          error={errors.appBase}
        >
          <input
            type="url"
            className={INPUT}
            id="app-base"
            value={draft.appBase}
            onChange={(e) => set('appBase', e.target.value)}
            spellCheck={false}
          />
        </Field>
        <Field
          id="api-base"
          label="API base"
          hint="Used by Copy transcript (via API) on pages other than YouTube. Start one locally with npm run dev:server."
          error={errors.apiBase}
        >
          <input
            type="url"
            className={INPUT}
            id="api-base"
            value={draft.apiBase}
            onChange={(e) => set('apiBase', e.target.value)}
            spellCheck={false}
          />
          {apiBase && (
            <div className="mt-2 flex items-center gap-3 text-sm">
              {apiAllowed ? (
                <span className="flex items-center gap-1.5 text-success">
                  <ShieldCheck size={16} /> Allowed to reach {new URL(apiBase).hostname}
                </span>
              ) : (
                <>
                  <span className="text-muted">Not yet allowed to reach {new URL(apiBase).hostname}.</span>
                  <Button onClick={allowApi}>Allow API access</Button>
                </>
              )}
            </div>
          )}
        </Field>
      </Section>

      <Section title="Copy for AI">
        <Field
          id="copy-format"
          label="Default copy format"
          hint="What Copy for AI puts on the clipboard. The list comes from the formats vid2context ships."
        >
          <select id="copy-format" className={INPUT} value={draft.copyFormat} onChange={(e) => set('copyFormat', e.target.value)}>
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.id === 'agent' ? 'agent (recommended)' : f.id}: {f.description}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="copy-template"
          label="Copy template"
          hint="Wraps the copied text. Placeholders: {{content}} (required), {{title}}, {{url}}, {{channel}}."
          error={errors.copyTemplate}
        >
          <textarea
            className={`${INPUT} min-h-28 font-mono text-[13px]`}
            id="copy-template"
            value={draft.copyTemplate}
            onChange={(e) => set('copyTemplate', e.target.value)}
            spellCheck={false}
          />
        </Field>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--v2c-accent)]"
            checked={draft.timestamps}
            onChange={(e) => set('timestamps', e.target.checked)}
          />
          <span>
            Include timestamps
            <span className="block text-muted">
              For the text format. The agent prompt and Markdown always cite with timestamps.
            </span>
          </span>
        </label>
      </Section>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => void save()} disabled={!valid || !dirty} icon={<Check size={16} />}>
          Save
        </Button>
        <Button variant="ghost" onClick={() => setDraft(DEFAULT_SETTINGS)} icon={<RotateCcw size={16} />}>
          Reset to defaults
        </Button>
        {note && (
          <span className="text-sm text-success" role="status">
            {note}
          </span>
        )}
      </div>
    </main>
  );
}

const INPUT =
  'w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-subtle hover:border-border-strong focus:border-accent focus:outline-none';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-subtle">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? <span className="text-sm text-danger">{error}</span> : hint && <span className="text-sm text-muted">{hint}</span>}
    </div>
  );
}
