/**
 * Run options as composer tools: mode and language menus, toggles for
 * comments and timestamps, and a button to attach a file.
 */
import type { TranscriptMode } from '@vid2context/core';
import { AudioLines, Check, Clock, Languages, MessageSquareText, Paperclip } from 'lucide-react';
import { useId } from 'react';
import { MODES } from '../../lib/route.ts';
import { IconButton } from '../ui.tsx';
import { Popover } from './Popover.tsx';

export interface RunOptions {
  lang: string;
  mode: TranscriptMode;
  comments: boolean;
  timestamps: boolean;
}

export const DEFAULT_OPTIONS: RunOptions = { lang: '', mode: 'auto', comments: false, timestamps: false };

/** Common caption languages offered as one-click picks; any BCP 47 code can be typed. */
export const QUICK_LANGS: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'hi', name: 'Hindi' },
];

const PILL = 'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm transition hover:bg-surface-3 hover:text-fg';
const ICON = 'size-[18px] shrink-0';

function ModeMenu({ value, onChange }: { value: TranscriptMode; onChange: (m: TranscriptMode) => void }) {
  const current = MODES.find((m) => m.id === value) ?? MODES[0];
  const name = useId();
  return (
    <Popover
      label={`Mode: ${current?.label}`}
      title="Mode"
      triggerClass={`${PILL} ${value === 'auto' ? 'text-muted' : 'bg-surface-3 text-fg'}`}
      trigger={
        <>
          <AudioLines className={ICON} strokeWidth={1.75} aria-hidden />
          <span>{current?.label}</span>
        </>
      }
    >
      {(close) => (
        <fieldset className="m-0 border-0 p-0">
          <legend className="sr-only">Mode</legend>
          {MODES.map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer items-start gap-3 rounded-v2c-sm px-2 py-2 hover:bg-surface-3 has-[:focus-visible]:bg-surface-3"
            >
              <input
                type="radio"
                name={name}
                value={m.id}
                checked={value === m.id}
                onChange={() => onChange(m.id)}
                onClick={(e) => {
                  // Arrow keys also fire click (with detail 0); only a real pointer click closes the menu.
                  if (e.detail > 0) close();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') close();
                }}
                className="sr-only"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-fg">{m.label}</span>
                <span className="block text-xs text-muted">{m.hint}</span>
              </span>
              <Check className={`mt-0.5 size-4 shrink-0 ${value === m.id ? 'text-fg' : 'invisible'}`} aria-hidden />
            </label>
          ))}
        </fieldset>
      )}
    </Popover>
  );
}

function LanguageMenu({ value, onChange }: { value: string; onChange: (lang: string) => void }) {
  const id = useId();
  return (
    <Popover
      label={`Language: ${value || 'automatic'}`}
      title="Language"
      triggerClass={`${PILL} ${value ? 'bg-surface-3 text-fg' : 'w-9 justify-center px-0 text-muted'}`}
      trigger={
        <>
          <Languages className={ICON} strokeWidth={1.75} aria-hidden />
          {value && <span className="font-mono text-[13px]">{value}</span>}
        </>
      }
    >
      {(close) => (
        <div className="space-y-2 px-2 pb-2">
          <label htmlFor={`${id}-lang`} className="sr-only">
            Language code
          </label>
          <input
            id={`${id}-lang`}
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                close();
              }
            }}
            placeholder="Automatic"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-hint`}
            className="w-full rounded-v2c-sm border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
          <p id={`${id}-hint`} className="text-xs text-muted">
            A language code such as en, de or pt-BR. Empty picks the video's own language.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {[{ code: '', name: 'Automatic' }, ...QUICK_LANGS].map((l) => (
              <button
                key={l.code || 'auto'}
                type="button"
                aria-pressed={value === l.code}
                onClick={() => {
                  onChange(l.code);
                  close();
                }}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${
                  value === l.code
                    ? 'border-accent bg-accent text-on-accent'
                    : 'border-border text-muted hover:border-border-strong hover:text-fg'
                }`}
              >
                {l.code ? (
                  <>
                    <span className="font-mono">{l.code}</span> {l.name}
                  </>
                ) : (
                  l.name
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

function Toggle({
  label,
  pressed,
  onChange,
  children,
}: {
  label: string;
  pressed: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <IconButton
      label={label}
      round
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={pressed ? 'bg-surface-3 text-fg' : ''}
    >
      {children}
    </IconButton>
  );
}

export function ComposerTools({
  value,
  onChange,
  onPickFile,
}: {
  value: RunOptions;
  onChange: (v: RunOptions) => void;
  onPickFile: () => void;
}) {
  const set = <K extends keyof RunOptions>(k: K, v: RunOptions[K]) => onChange({ ...value, [k]: v });
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
      <legend className="sr-only">Options</legend>
      <ModeMenu value={value.mode} onChange={(m) => set('mode', m)} />
      <LanguageMenu value={value.lang} onChange={(l) => set('lang', l)} />
      <Toggle label="Include comments" pressed={value.comments} onChange={(v) => set('comments', v)}>
        <MessageSquareText className={ICON} strokeWidth={1.75} aria-hidden />
      </Toggle>
      <Toggle label="Timestamps in transcript.txt" pressed={value.timestamps} onChange={(v) => set('timestamps', v)}>
        <Clock className={ICON} strokeWidth={1.75} aria-hidden />
      </Toggle>
      <IconButton label="Attach a video or audio file" round onClick={onPickFile}>
        <Paperclip className={ICON} strokeWidth={1.75} aria-hidden />
      </IconButton>
    </fieldset>
  );
}
