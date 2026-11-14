/**
 * The composer: a large link input, a row of tools, the round "Get context"
 * button, and an optional strip under it (the file drop zone on home).
 * Enter submits.
 */
import { ArrowUp } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';

export const PLACEHOLDER = 'Paste a YouTube, Vimeo, TikTok, podcast or any video link';

export function UrlForm({
  onSubmit,
  initial = '',
  tools,
  footer,
  submitLabel = 'Get context',
  formLabel = 'Get context for a video link',
}: {
  onSubmit: (url: string) => void;
  initial?: string;
  /** Controls shown left of the submit button. */
  tools?: ReactNode;
  /** A strip attached under the composer. */
  footer?: ReactNode;
  /** Name of the round submit button. */
  submitLabel?: string;
  /** Accessible name of the form. */
  formLabel?: string;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const url = value.trim();
    if (!url) {
      setError('Paste a link first.');
      input.current?.focus();
      return;
    }
    setError('');
    onSubmit(url);
  };
  return (
    <form onSubmit={submit} className="w-full" aria-label={formLabel}>
      <div className="rounded-[22px] border border-border bg-surface shadow-v2c transition focus-within:border-border-strong">
        <label htmlFor={id} className="sr-only">
          Video link
        </label>
        <input
          ref={input}
          id={id}
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={PLACEHOLDER}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="block w-full min-w-0 bg-transparent px-5 pb-6 pt-5 text-base text-fg placeholder:text-subtle focus:outline-none focus-visible:outline-none sm:pb-8"
        />
        <div className="flex items-end gap-2 px-3 pb-3">
          <div className="min-w-0 flex-1">{tools}</div>
          <button
            type="submit"
            aria-label={submitLabel}
            title={`${submitLabel} (Enter)`}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition hover:opacity-90"
          >
            <ArrowUp className="size-5" strokeWidth={2.25} aria-hidden />
          </button>
        </div>
        {footer && <div className="rounded-b-[21px] border-t border-border bg-surface-2/50">{footer}</div>}
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-2 px-2 text-sm text-fg" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
