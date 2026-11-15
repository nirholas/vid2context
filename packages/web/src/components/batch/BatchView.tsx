/**
 * Playlists, channels and feeds: GET /items expands the list, the user picks
 * videos, each runs as a `context` job (POST /jobs plus its event stream, or
 * GET /context when the server has no jobs) a few at a time, and the
 * finished ones become one combined bundle. Loaded on demand.
 *
 * Rows show the title and length the list page gave (VideoRef hints) until a
 * video is loaded. A video whose job waits to retry (YouTube blocks back off
 * for minutes) shows a countdown and "Retry now", which cancels that job and
 * starts a fresh one in the same slot.
 */
import { agentPrompt, type Bundle, type VideoContext, type VideoRef } from '@vid2context/core';
import { Bot, CircleCheck, CircleX, FileArchive, ListVideo, Play, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getItems } from '../../lib/api.ts';
import { resultBundle } from '../../lib/bundle.ts';
import { saveBlob, streamToBlob } from '../../lib/download.ts';
import { type AppError, isAbort, toAppError } from '../../lib/errors.ts';
import { formatDuration } from '../../lib/format.ts';
import { putEntry, summarize } from '../../lib/history.ts';
import { contextViaJob } from '../../lib/jobs.ts';
import { runPool } from '../../lib/pool.ts';
import { appHref, onAppLinkClick, type RunParams, runSearch } from '../../lib/route.ts';
import { ErrorPanel } from '../ErrorPanel.tsx';
import { Button, Card, CopyButton, ProgressBar, Spinner } from '../ui.tsx';

/** Videos fetched at once. The server runs each pipeline in full, so a few in parallel keep it responsive. */
export const CONCURRENCY = 3;

export type ItemState =
  | { status: 'idle' }
  | { status: 'queued' }
  | { status: 'running'; message?: string; retryAt?: number }
  | { status: 'done'; context: VideoContext }
  | { status: 'error'; error: AppError };

function refInput(ref: VideoRef): string {
  return ref.url ?? ref.input;
}

/** The list without repeated videos (some sources list a video twice), first occurrence kept. */
export function uniqueRefs(list: VideoRef[]): { items: VideoRef[]; repeats: number } {
  const seen = new Set<string>();
  const items = list.filter((r) => !seen.has(r.id) && Boolean(seen.add(r.id)));
  return { items, repeats: list.length - items.length };
}

/** Counts for the progress line: failures are finished but never "done". */
export function batchCounts(states: Record<string, ItemState>): { total: number; done: number; failed: number } {
  const all = Object.values(states).filter((s) => s.status !== 'idle');
  return {
    total: all.length,
    done: all.filter((s) => s.status === 'done').length,
    failed: all.filter((s) => s.status === 'error').length,
  };
}

export function progressText(c: { total: number; done: number; failed: number }, running: boolean): string {
  const parts = [`${c.done} of ${c.total} done`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (running) parts.push(`up to ${CONCURRENCY} at a time`);
  return parts.join(', ');
}

/** "45 s", "9 min 5 s", "1 h 2 min": how long until a retry. */
export function waitText(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 ? `${min} min ${sec % 60} s` : `${min} min`;
  return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 60)} h`;
}

/** Seconds ticking down to a retry, re-rendered every second while shown. */
function RetryCountdown({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{at > now ? `Retrying in ${waitText(at - now)}` : 'Retrying now'}</>;
}

/** The abort reason of "Retry now", so the worker can tell it from Stop. */
function retryNowReason(): DOMException {
  return new DOMException('Retry now', 'AbortError');
}

export function BatchView({ params }: { params: RunParams }) {
  const [items, setItems] = useState<VideoRef[]>();
  const [repeats, setRepeats] = useState(0);
  const [loadError, setLoadError] = useState<unknown>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [running, setRunning] = useState(false);
  const [bundle, setBundle] = useState<Bundle>();
  const abort = useRef<AbortController | null>(null);
  /** The controller of each running video, for "Retry now". */
  const itemAbort = useRef(new Map<string, AbortController>());
  const [reload, setReload] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the request when the user presses "Try again"
  useEffect(() => {
    const ac = new AbortController();
    setItems(undefined);
    setLoadError(undefined);
    getItems(params.url, { signal: ac.signal }).then(
      (list) => {
        const unique = uniqueRefs(list);
        setItems(unique.items);
        setRepeats(unique.repeats);
        setSelected(new Set(unique.items.map((r) => r.id)));
      },
      (err) => !isAbort(err) && setLoadError(err),
    );
    return () => ac.abort();
  }, [params.url, reload]);

  useEffect(() => () => abort.current?.abort(), []);

  const done = useMemo(
    () =>
      (items ?? [])
        .map((r) => states[r.id])
        .filter((s): s is Extract<ItemState, { status: 'done' }> => s?.status === 'done')
        .map((s) => s.context),
    [items, states],
  );
  const counts = batchCounts(states);

  useEffect(() => {
    if (running || !done.length) {
      setBundle(undefined);
      return;
    }
    let live = true;
    resultBundle(done).then((b) => live && setBundle(b));
    return () => {
      live = false;
    };
  }, [done, running]);

  if (loadError) {
    return (
      <ErrorPanel title="Could not list the videos" error={loadError} onRetry={() => setReload((n) => n + 1)} showSettings />
    );
  }
  if (!items) {
    return (
      <p className="flex items-center gap-2 py-10 text-sm text-muted" role="status">
        <Spinner /> Listing the videos in {params.url}
      </p>
    );
  }

  const all = items.length > 0 && selected.size === items.length;
  const some = selected.size > 0 && !all;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** One video, run again at once when "Retry now" aborts it; returns when it is done, failed or stopped. */
  const runOne = async (ref: VideoRef, batch: AbortSignal) => {
    const input = refInput(ref);
    for (;;) {
      const own = new AbortController();
      const onStop = () => own.abort(batch.reason);
      batch.addEventListener('abort', onStop, { once: true });
      itemAbort.current.set(ref.id, own);
      setStates((s) => ({ ...s, [ref.id]: { status: 'running' } }));
      try {
        const context = await contextViaJob(
          input,
          { mode: params.mode, lang: params.lang || undefined, comments: params.comments },
          (p) =>
            setStates((s) => ({
              ...s,
              [ref.id]: {
                status: 'running',
                message: p.message,
                ...(p.retryAt && !Number.isNaN(Date.parse(p.retryAt)) ? { retryAt: Date.parse(p.retryAt) } : {}),
              },
            })),
          { signal: own.signal },
        );
        setStates((s) => ({ ...s, [ref.id]: { status: 'done', context } }));
        const b = await resultBundle([context]);
        await putEntry(summarize(context, { input, mode: params.mode, lang: params.lang }, b.files.length)).catch((err) =>
          console.error('[vid2context] could not save to history', err),
        );
        return;
      } catch (err) {
        const retryNow =
          own.signal.aborted && !batch.aborted && (own.signal.reason as Error | undefined)?.message === 'Retry now';
        if (retryNow) continue;
        if (isAbort(err) || batch.aborted) {
          setStates((s) => ({ ...s, [ref.id]: { status: 'idle' } }));
          return;
        }
        setStates((s) => ({ ...s, [ref.id]: { status: 'error', error: toAppError(err) } }));
        return;
      } finally {
        batch.removeEventListener('abort', onStop);
        if (itemAbort.current.get(ref.id) === own) itemAbort.current.delete(ref.id);
      }
    }
  };

  const run = async () => {
    const chosen = items.filter((r) => selected.has(r.id));
    if (!chosen.length) return;
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);
    setStates(Object.fromEntries(chosen.map((r) => [r.id, { status: 'queued' } as ItemState])));
    await runPool(chosen, CONCURRENCY, (ref) => runOne(ref, ac.signal), ac.signal);
    setRunning(false);
  };

  const retryNow = (id: string) => itemAbort.current.get(id)?.abort(retryNowReason());

  const stop = () => {
    abort.current?.abort();
    setRunning(false);
  };

  const downloadZip = async () => {
    if (bundle) saveBlob(await streamToBlob(bundle.zip(), 'application/zip'), bundle.filename);
  };

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-3">
        <ListVideo className="mt-1 size-6 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-fg">
            {items.length} video{items.length === 1 ? '' : 's'} in this list
          </h1>
          <p className="truncate font-mono text-sm text-muted">{params.url}</p>
          {repeats > 0 && (
            <p className="text-xs text-muted" data-testid="batch-repeats">
              {repeats} repeated entr{repeats === 1 ? 'y' : 'ies'} left out.
            </p>
          )}
        </div>
      </header>

      {items.length === 0 ? (
        <p className="text-sm text-muted">The list is empty.</p>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={all}
                ref={(el) => {
                  if (el) el.indeterminate = some;
                }}
                onChange={() => setSelected(all ? new Set() : new Set(items.map((r) => r.id)))}
                disabled={running}
                className="size-4 accent-[var(--v2c-accent)]"
              />
              Select all
            </label>
            <span className="text-sm text-muted">{selected.size} selected</span>
            <div className="ml-auto flex gap-2">
              {running ? (
                <Button onClick={stop}>Stop</Button>
              ) : (
                <Button variant="accent" onClick={run} disabled={!selected.size}>
                  <Play className="size-4" aria-hidden /> Get context for {selected.size}
                </Button>
              )}
            </div>
          </div>
          {counts.total > 0 && (
            <div className="space-y-1 border-b border-border px-4 py-3">
              <ProgressBar value={((counts.done + counts.failed) / counts.total) * 100} label="Batch progress" />
              <p className="text-xs text-muted" role="status" aria-live="polite" data-testid="batch-progress">
                {progressText(counts, running)}
              </p>
            </div>
          )}
          <ul className="divide-y divide-border" data-testid="batch-items">
            {items.map((ref, i) => {
              const s = states[ref.id] ?? { status: 'idle' };
              const input = refInput(ref);
              const title = s.status === 'done' ? s.context.metadata.title : (ref.title ?? input);
              const durationSec = s.status === 'done' ? (s.context.metadata.durationSec ?? ref.durationSec) : ref.durationSec;
              const named = s.status === 'done' || Boolean(ref.title);
              const open = runSearch({ ...params, url: input });
              return (
                <li key={ref.id} className="px-4 py-3" data-testid="batch-item">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selected.has(ref.id)}
                      onChange={() => toggle(ref.id)}
                      disabled={running}
                      aria-label={`Select video ${i + 1}: ${title}`}
                      className="mt-1 size-4 accent-[var(--v2c-accent)]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 items-baseline gap-2 text-sm text-fg">
                        <span className="shrink-0 text-muted tabular-nums">{i + 1}.</span>
                        {s.status === 'done' ? (
                          <a
                            href={appHref(open)}
                            onClick={(e) => onAppLinkClick(e, open)}
                            className="truncate underline-offset-4 hover:underline"
                          >
                            {title}
                          </a>
                        ) : (
                          <span className={named ? 'truncate' : 'truncate font-mono text-[0.8125rem]'}>{title}</span>
                        )}
                        {durationSec !== undefined && (
                          <span className="shrink-0 text-xs text-muted tabular-nums" data-testid="batch-duration">
                            {formatDuration(durationSec)}
                          </span>
                        )}
                      </p>
                      {named && s.status !== 'done' && <p className="truncate font-mono text-xs text-subtle">{input}</p>}
                      {s.status === 'running' && (s.message || s.retryAt) && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                          <span className="min-w-0 break-words" data-testid="batch-message">
                            {s.retryAt ? (
                              <>
                                {s.message?.replace(/; retrying in \d+ s\.?$/, '.')} <RetryCountdown at={s.retryAt} />
                              </>
                            ) : (
                              s.message
                            )}
                          </span>
                          {s.retryAt && (
                            <button
                              type="button"
                              onClick={() => retryNow(ref.id)}
                              className="inline-flex items-center gap-1 font-medium text-fg underline-offset-4 hover:underline"
                              title="Cancel the wait and try again now. A YouTube block may still be in place."
                              data-testid="batch-retry-now"
                            >
                              <RotateCw className="size-3.5" aria-hidden /> Retry now
                            </button>
                          )}
                        </div>
                      )}
                      {s.status === 'error' && (
                        <div className="mt-1 text-sm">
                          <p className="text-fg">{s.error.message}</p>
                          {s.error.hint && <p className="text-muted">{s.error.hint}</p>}
                        </div>
                      )}
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                      {s.status === 'queued' && 'Waiting'}
                      {s.status === 'running' && (
                        <>
                          <Spinner /> {s.retryAt ? 'Waiting to retry' : 'Working'}
                        </>
                      )}
                      {s.status === 'done' && (
                        <>
                          <CircleCheck className="size-4 text-success" aria-hidden /> {s.context.transcript.origin}
                        </>
                      )}
                      {s.status === 'error' && (
                        <>
                          <CircleX className="size-4 text-danger" aria-hidden /> {s.error.code}
                        </>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {!running && done.length > 0 && (
        <Card className="space-y-3 p-5">
          <h2 className="text-base font-semibold text-fg">
            Combined result: {done.length} video{done.length === 1 ? '' : 's'}
          </h2>
          <p className="text-sm text-muted">
            One bundle with a combined context pack, an index, llms.txt and a folder per video. Open any finished video above for
            its own files.
          </p>
          <div className="flex flex-wrap gap-2">
            <CopyButton
              variant="accent"
              getText={() => agentPrompt(done)}
              label="Copy for agents"
              copiedLabel="Copied for agents"
              icon={<Bot className="size-4" aria-hidden />}
            />
            <Button onClick={downloadZip} disabled={!bundle}>
              {bundle ? <FileArchive className="size-4" aria-hidden /> : <Spinner />}
              {bundle ? `Download .zip (${bundle.files.length} files)` : 'Preparing files'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

export default BatchView;
