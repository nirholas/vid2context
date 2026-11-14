/** Run options, collapsed by default: language, mode, comments, timestamps. */
import type { TranscriptMode } from '@vid2context/core';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { MODES } from '../../lib/route.ts';

export interface RunOptions {
  lang: string;
  mode: TranscriptMode;
  comments: boolean;
  timestamps: boolean;
}

export const DEFAULT_OPTIONS: RunOptions = { lang: '', mode: 'auto', comments: false, timestamps: false };

export function Options({ value, onChange }: { value: RunOptions; onChange: (v: RunOptions) => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const set = <K extends keyof RunOptions>(k: K, v: RunOptions[K]) => onChange({ ...value, [k]: v });
  const changed = value.lang || value.mode !== 'auto' || value.comments || value.timestamps;
  const mode = MODES.find((m) => m.id === value.mode);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-v2c-sm px-2 py-1 text-sm text-muted hover:text-fg"
      >
        <ChevronDown className={`size-4 transition ${open ? 'rotate-180' : ''}`} aria-hidden />
        Options
        {changed && !open ? <span className="text-xs">(changed)</span> : null}
      </button>
      {open && (
        <div id={`${id}-panel`} className="mt-2 grid gap-4 rounded-v2c border border-border bg-surface p-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${id}-lang`} className="text-sm font-medium text-fg">
              Language
            </label>
            <input
              id={`${id}-lang`}
              value={value.lang}
              onChange={(e) => set('lang', e.target.value.trim())}
              placeholder="Automatic"
              aria-describedby={`${id}-lang-hint`}
              className="w-full rounded-v2c-sm border border-border bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-muted"
            />
            <p id={`${id}-lang-hint`} className="text-xs text-muted">
              A language code such as en, de or pt-BR. Empty picks the video's own language.
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-mode`} className="text-sm font-medium text-fg">
              Mode
            </label>
            <select
              id={`${id}-mode`}
              value={value.mode}
              onChange={(e) => set('mode', e.target.value as TranscriptMode)}
              aria-describedby={`${id}-mode-hint`}
              className="w-full rounded-v2c-sm border border-border bg-surface-2 px-3 py-2 text-sm text-fg"
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p id={`${id}-mode-hint`} className="text-xs text-muted">
              {mode?.hint}
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={value.comments}
              onChange={(e) => set('comments', e.target.checked)}
              className="mt-0.5 size-4 accent-[var(--v2c-accent)]"
            />
            <span>
              Include comments
              <span className="block text-xs text-muted">Fetch viewer comments as well, where the platform allows.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={value.timestamps}
              onChange={(e) => set('timestamps', e.target.checked)}
              className="mt-0.5 size-4 accent-[var(--v2c-accent)]"
            />
            <span>
              Timestamps in transcript.txt
              <span className="block text-xs text-muted">Start each line with [m:ss]. The other files always have them.</span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
