/**
 * The Download page (?view=download&url=...): paste a link, pick video or
 * audio, save the file. A playlist or channel link lists its videos; one set
 * of choices applies to all of them and the jobs run one after another, so
 * the server is never asked for many downloads at once.
 */
import type { VideoRef } from '@vid2context/core';
import { Download, ListVideo } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CallOptions, getItems, isListError } from '../../lib/api.ts';
import {
  buildBody,
  DEFAULT_SETTINGS,
  type DownloadJob,
  type DownloadSettings,
  type DownloadStatus,
  startDownload,
} from '../../lib/downloads.ts';
import { shortInput } from '../../lib/format.ts';
import { downloadSearch, navigate } from '../../lib/route.ts';
import { ErrorPanel } from '../ErrorPanel.tsx';
import { UrlForm } from '../home/UrlForm.tsx';
import { PlaylistNotice } from '../playlist/PlaylistNotice.tsx';
import { Button, Spinner } from '../ui.tsx';
import { DownloadForm } from './DownloadForm.tsx';
import { DownloadJobView, POLL_MS } from './DownloadJobView.tsx';
import { DownloadPanel } from './DownloadPanel.tsx';
import { useDownloadStatus } from './use-download-status.ts';

/** Most items listed from one playlist or channel. */
export const LIST_LIMIT = 50;

type ItemState = { job?: DownloadJob; error?: unknown; queued?: boolean };

export function PlaylistDownloads({
  url,
  status,
  call = {},
  pollMs = POLL_MS,
}: {
  url: string;
  status: DownloadStatus;
  call?: CallOptions;
  pollMs?: number;
}) {
  const [items, setItems] = useState<VideoRef[]>();
  const [error, setError] = useState<unknown>();
  const [settings, setSettings] = useState<DownloadSettings>(DEFAULT_SETTINGS);
  const [state, setState] = useState<Record<string, ItemState>>({});
  const [queue, setQueue] = useState<string[]>([]);
  const [active, setActive] = useState<string>();
  const callRef = useRef(call);
  callRef.current = call;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const ctrl = new AbortController();
    setItems(undefined);
    setError(undefined);
    getItems(url, { ...callRef.current, signal: ctrl.signal }, LIST_LIMIT).then(setItems, (err) => {
      if ((err as { name?: string }).name !== 'AbortError') setError(err);
    });
    return () => ctrl.abort();
  }, [url]);

  const patch = useCallback((key: string, p: ItemState) => setState((s) => ({ ...s, [key]: { ...s[key], ...p } })), []);

  // Start the next queued item when nothing is running.
  useEffect(() => {
    if (active || queue.length === 0) return;
    const [next, ...rest] = queue as [string, ...string[]];
    setQueue(rest);
    setActive(next);
    startDownload(buildBody(next, settingsRef.current), callRef.current).then(
      (job) => patch(next, { job, queued: false }),
      (err) => {
        patch(next, { error: err, queued: false });
        setActive(undefined);
      },
    );
  }, [active, queue, patch]);

  const enqueue = (keys: string[]) => {
    const fresh = keys.filter((k) => !state[k]?.job && !state[k]?.queued && k !== active && !queue.includes(k));
    if (fresh.length === 0) return;
    setState((s) => {
      const n = { ...s };
      for (const k of fresh) n[k] = { queued: true };
      return n;
    });
    setQueue((q) => [...q, ...fresh]);
  };

  if (error) return <ErrorPanel error={error} title="Could not list the videos" />;
  if (!items) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner /> Listing the videos
      </p>
    );
  }
  const keyOf = (r: VideoRef) => r.url ?? r.id;
  const pending = items.filter((r) => !state[keyOf(r)]?.job && !state[keyOf(r)]?.queued).length;

  return (
    <div className="space-y-4" data-testid="playlist-downloads">
      <p className="flex items-center gap-2 text-sm text-fg">
        <ListVideo className="size-4 text-muted" aria-hidden />
        {items.length} video{items.length === 1 ? '' : 's'}
        {items.length >= LIST_LIMIT ? ` (the first ${LIST_LIMIT})` : ''}. One set of choices applies to each; they download one at
        a time.
      </p>
      <DownloadForm settings={settings} onChange={setSettings} qualities={status.qualities} disabled={!!active} />
      <Button variant="accent" onClick={() => enqueue(items.map(keyOf))} disabled={pending === 0} data-testid="download-all">
        <Download className="size-4" aria-hidden /> Download all ({pending})
      </Button>
      <ol className="divide-y divide-border rounded-v2c border border-border" data-testid="playlist-items">
        {items.map((r, i) => {
          const key = keyOf(r);
          const s = state[key] ?? {};
          return (
            <li key={key} className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="w-6 shrink-0 text-right text-xs text-subtle tabular-nums">{i + 1}</span>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-fg hover:underline"
                >
                  {shortInput(r.url ?? r.id, 80)}
                </a>
                {!s.job && !s.queued && (
                  <Button variant="secondary" className="px-2.5 py-1" onClick={() => enqueue([key])}>
                    <Download className="size-3.5" aria-hidden /> Download
                  </Button>
                )}
                {s.queued && <span className="text-xs text-muted">Queued</span>}
              </div>
              {s.error ? <ErrorPanel error={s.error} title="The download did not start" /> : null}
              {s.job && (
                <DownloadJobView
                  job={s.job}
                  call={call}
                  pollMs={pollMs}
                  compact
                  onFinished={() => setActive((a) => (a === key ? undefined : a))}
                />
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-subtle">{status.notice}</p>
    </div>
  );
}

export function DownloadPage({ url, call, pollMs }: { url?: string; call?: CallOptions; pollMs?: number }) {
  const availability = useDownloadStatus(call);
  const [isList, setIsList] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new link starts as a single video again.
  useEffect(() => setIsList(false), [url]);

  return (
    <div className="space-y-6 pt-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-fg">Download video or audio</h1>
        <p className="text-sm text-muted">
          Save a video as MP4, WebM or MKV, or its sound as MP3, M4A, Opus, FLAC or WAV. Works with YouTube and the other sites
          yt-dlp supports.
        </p>
      </header>

      {availability.state === 'checking' && (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner /> Checking whether this server offers downloads
        </p>
      )}
      {availability.state === 'off' && (
        <section className="rounded-v2c-lg border border-border bg-surface p-5" data-testid="downloads-off">
          <p className="font-medium text-fg">Downloads are not available here</p>
          <p className="mt-1 text-sm text-muted">{availability.reason}</p>
        </section>
      )}
      {availability.state === 'on' && (
        <>
          <UrlForm
            key={url ?? ''}
            initial={url ?? ''}
            submitLabel="Show download options"
            formLabel="Download a video link"
            onSubmit={(u) => navigate(downloadSearch(u))}
          />
          {url &&
            (isList ? (
              <PlaylistDownloads url={url} status={availability.status} call={call} pollMs={pollMs} />
            ) : (
              <section className="space-y-4 rounded-v2c-lg border border-border bg-surface p-4 sm:p-5">
                <PlaylistNotice input={url} searchFor={downloadSearch} call={call} />
                <DownloadPanel
                  url={url}
                  status={availability.status}
                  call={call}
                  pollMs={pollMs}
                  showTitle
                  onError={(err) => {
                    if (!isListError(err)) return false;
                    setIsList(true);
                    return true;
                  }}
                />
              </section>
            ))}
          {!url && <p className="text-xs text-subtle">{availability.status.notice}</p>}
        </>
      )}
    </div>
  );
}

export default DownloadPage;
