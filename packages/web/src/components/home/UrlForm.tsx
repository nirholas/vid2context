/** The big link input with the "Get context" button. Enter submits. */
import { ArrowRight, Link2 } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';

export const PLACEHOLDER = 'Paste a YouTube, Vimeo, TikTok, podcast or any video link';

export function UrlForm({ onSubmit, initial = '' }: { onSubmit: (url: string) => void; initial?: string }) {
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
    <form onSubmit={submit} className="w-full" role="search" aria-label="Get context for a video link">
      <label htmlFor={id} className="sr-only">
        Video link
      </label>
      <div className="flex flex-col gap-2 rounded-v2c-lg border border-border-strong bg-surface p-2 shadow-v2c focus-within:border-accent sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
          <Link2 className="size-5 shrink-0 text-muted" aria-hidden />
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
            className="min-w-0 flex-1 bg-transparent py-3 text-base text-fg placeholder:text-muted focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="v2c-gradient inline-flex items-center justify-center gap-2 rounded-v2c px-6 py-3 text-[1.1875rem] font-bold text-on-accent transition hover:brightness-110"
        >
          Get context <ArrowRight className="size-5" aria-hidden />
        </button>
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-2 px-2 text-sm text-fg" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
