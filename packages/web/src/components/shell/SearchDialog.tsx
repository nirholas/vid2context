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
  const [active, setActive] = useState(0);
  const id = useId();
  const hits = useMemo(() => entries.filter((e) => matchesQuery(e, query)), [entries, query]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      setActive(0);
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
      <div className="flex items-center gap-3 border-b border-border px-4">
        <Search className="size-[18px] shrink-0 text-muted" aria-hidden />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={hits[active] ? `${id}-opt-${active}` : undefined}
          aria-label="Search saved results"
          placeholder="Search saved results by title, channel or link"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, hits.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              go(hits[active]);
            }
          }}
          className="min-w-0 flex-1 bg-transparent py-3.5 text-[15px] text-fg placeholder:text-subtle focus:outline-none"
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
          <ul id={`${id}-list`} role="listbox" aria-label="Saved results">
            {hits.map((e, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection runs through the combobox input (arrows and Enter).
              <li
                key={e.key}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={() => go(e)}
                className={`flex cursor-pointer items-center gap-3 rounded-v2c-sm px-3 py-2.5 ${i === active ? 'bg-surface-3' : ''}`}
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
                {i === active && <CornerDownLeft className="size-4 shrink-0 text-muted" aria-hidden />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
