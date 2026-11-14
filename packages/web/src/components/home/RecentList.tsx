/** Recent results from this browser's history, with an inline "Clear history" confirmation. */
import { Film, History, Trash } from 'lucide-react';
import { useState } from 'react';
import { formatDuration, timeAgo } from '../../lib/format.ts';
import type { HistorySummary } from '../../lib/history.ts';
import { appHref, onAppLinkClick, readMode, runSearch } from '../../lib/route.ts';
import { Button, SectionTitle } from '../ui.tsx';

function Thumb({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-v2c-sm bg-surface-3 sm:w-32">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex size-full items-center justify-center text-subtle">
          <Film className="size-5" aria-hidden />
        </div>
      )}
    </div>
  );
}

export function RecentList({
  entries,
  total,
  onClear,
  now = Date.now(),
}: {
  entries: HistorySummary[];
  total: number;
  onClear: () => Promise<void>;
  now?: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  if (!entries.length) return null;
  return (
    <section aria-labelledby="recent-title" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle id="recent-title" icon={<History className="size-[18px] text-muted" strokeWidth={1.75} aria-hidden />}>
          Recent results
        </SectionTitle>
        <div className="ml-auto flex items-center gap-2">
          {confirming ? (
            <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
              <legend className="sr-only">Confirm clearing history</legend>
              <span className="text-sm text-fg">
                Delete all {total} saved result{total === 1 ? '' : 's'} from this browser?
              </span>
              <Button
                variant="secondary"
                className="border-danger/70"
                disabled={clearing}
                onClick={async () => {
                  setClearing(true);
                  try {
                    await onClear();
                  } finally {
                    setClearing(false);
                    setConfirming(false);
                  }
                }}
              >
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} autoFocus>
                Cancel
              </Button>
            </fieldset>
          ) : (
            <Button variant="ghost" className="px-2 py-1" onClick={() => setConfirming(true)}>
              <Trash className="size-4" aria-hidden /> Clear history
            </Button>
          )}
        </div>
      </div>
      <ul className="space-y-2" data-testid="recent-list">
        {entries.map((e) => {
          const search = runSearch({ url: e.input, mode: readMode(e.mode), lang: e.lang });
          return (
            <li key={e.key}>
              <a
                href={appHref(search)}
                onClick={(ev) => onAppLinkClick(ev, search)}
                className="flex items-center gap-4 rounded-v2c-lg border border-border bg-surface p-3 transition hover:border-border-strong hover:bg-surface-2"
              >
                <Thumb src={e.thumbnailUrl} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-fg">{e.title}</p>
                  <p className="mt-0.5 truncate text-[13px] text-muted">
                    {[e.channel, e.durationSec !== undefined ? formatDuration(e.durationSec) : undefined]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="rounded-md bg-surface-3 px-2 py-0.5 text-fg">{e.fileCount} files</span>
                    <span>{timeAgo(e.savedAt, now)}</span>
                  </p>
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
