/**
 * Search saved results (Ctrl+K or Cmd+K): title, channel and link, newest
 * first. A native <dialog>, so focus is trapped and Escape closes it.
 */
import { CornerDownLeft, Film, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatDuration, timeAgo } from '../../lib/format.ts';
import { type HistorySummary, MAX_ENTRIES } from '../../lib/history.ts';
import { navigate, readMode, runSearch } from '../../lib/route.ts';
import { useRecentResults } from '../../lib/use-history.ts';

export function matchesQuery(e: HistorySummary, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [e.title, e.channel ?? '', e.input].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { entries, loaded } = useRecentResults(MAX_ENTRIES);
  const [query, setQuery] = useState('');
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const hits = useMemo(() => entries.filter((e) => matchesQuery(e, query)), [entries, query]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      d.showModal();
      input.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  const go = (e: HistorySummary | undefined) => {
    if (!e) return;
    onClose();
    navigate(runSearch({ url: e.input, mode: readMode(e.mode), lang: e.lang }));
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      className="m-auto mt-[12vh] w-[min(40rem,calc(100vw-2rem))] overflow-hidden rounded-v2c-lg border border-border bg-surface-2 p-0 text-fg shadow-v2c backdrop:bg-black/60"
    >
      <h2 id={`${id}-title`} className="sr-only">
        Search saved results
      </h2>
      <p id={`${id}-help`} className="sr-only">
        Enter opens the first match. Arrow down moves into the list.
      </p>
      <div className="flex items-center gap-3 border-b border-border px-4">
        <Search className="size-[18px] shrink-0 text-muted" aria-hidden />
        <input
          ref={input}
          type="search"
          aria-label="Search saved results"
          placeholder="Search saved results by title, channel or link"
          value={query}
          aria-describedby={`${id}-help`}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              list.current?.querySelector('button')?.focus();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              go(hits[0]);
            }
          }}
          className="min-w-0 flex-1 bg-transparent py-3.5 text-[15px] text-fg placeholder:text-subtle focus:outline-none focus-visible:outline-none"
        />
        <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted sm:block">Esc</kbd>
      </div>
      <div className="max-h-[min(26rem,60vh)] overflow-y-auto p-2">
        {loaded && hits.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted" role="status">
            {entries.length === 0
              ? 'Nothing saved yet. Results you open are kept in this browser.'
              : `No saved result matches "${query}".`}
          </p>
        ) : (
          <ul
            ref={list}
            aria-label="Saved results"
            onKeyDown={(e) => {
              const buttons = Array.from(list.current?.querySelectorAll('button') ?? []);
              const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                buttons[Math.min(i + 1, buttons.length - 1)]?.focus();
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (i <= 0) input.current?.focus();
                else buttons[i - 1]?.focus();
              }
            }}
          >
            {hits.map((e) => (
              <li key={e.key}>
                <button
                  type="button"
                  onClick={() => go(e)}
                  className="group flex w-full items-center gap-3 rounded-v2c-sm px-3 py-2.5 text-left hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none"
                >
                  <Film className="size-4 shrink-0 text-subtle" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{e.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {[e.channel, e.durationSec !== undefined ? formatDuration(e.durationSec) : undefined, timeAgo(e.savedAt)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <CornerDownLeft
                    className="size-4 shrink-0 text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
