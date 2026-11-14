/**
 * Playlists, channels and feeds: GET /items expands the list, the user picks
 * videos, they run through GET /context a few at a time, and the finished
 * ones become one combined bundle. Loaded on demand.
 */
import { agentPrompt, type Bundle, type VideoContext, type VideoRef } from '@vid2context/core';
import { Bot, CircleCheck, CircleX, FileArchive, ListVideo, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getContext, getItems } from '../../lib/api.ts';
import { resultBundle } from '../../lib/bundle.ts';
import { saveBlob, streamToBlob } from '../../lib/download.ts';
import { type AppError, isAbort, toAppError } from '../../lib/errors.ts';
import { putEntry, summarize } from '../../lib/history.ts';
import { appHref, onAppLinkClick, type RunParams, runSearch } from '../../lib/route.ts';
import { runPool } from '../../lib/pool.ts';
import { ErrorPanel } from '../ErrorPanel.tsx';
import { Button, Card, CopyButton, ProgressBar, Spinner } from '../ui.tsx';

/** Videos fetched at once. The server runs each pipeline in full, so a few in parallel keep it responsive. */
export const CONCURRENCY = 3;

type ItemState =
  | { status: 'idle' }
  | { status: 'queued' }
  | { status: 'running' }
  | { status: 'done'; context: VideoContext }
  | { status: 'error'; error: AppError };

function refInput(ref: VideoRef): string {
  return ref.url ?? ref.input;
}

export function BatchView({ params }: { params: RunParams }) {
  const [items, setItems] = useState<VideoRef[]>();
  const [loadError, setLoadError] = useState<unknown>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [running, setRunning] = useState(false);
  const [bundle, setBundle] = useState<Bundle>();
  const abort = useRef<AbortController | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setItems(undefined);
    setLoadError(undefined);
    getItems(params.url, { signal: ac.signal }).then(
      (list) => {
        setItems(list);
        setSelected(new Set(list.map((r) => r.id)));
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
  const finished = Object.values(states).filter((s) => s.status === 'done' || s.status === 'error').length;
  const total = Object.values(states).filter((s) => s.status !== 'idle').length;

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
    return <ErrorPanel title="Could not list the videos" error={loadError} onRetry={() => setReload((n) => n + 1)} showSettings />;
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

  const run = async () => {
    const chosen = items.filter((r) => selected.has(r.id));
    if (!chosen.length) return;
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);
    setStates(Object.fromEntries(chosen.map((r) => [r.id, { status: 'queued' } as ItemState])));
    await runPool(
      chosen,
      CONCURRENCY,
      async (ref) => {
        setStates((s) => ({ ...s, [ref.id]: { status: 'running' } }));
        try {
          const input = refInput(ref);
          const context = await getContext(input, { mode: params.mode, lang: params.lang || undefined }, { signal: ac.signal });
          setStates((s) => ({ ...s, [ref.id]: { status: 'done', context } }));
          const b = await resultBundle([context]);
          await putEntry(summarize(context, { input, mode: params.mode, lang: params.lang }, b.files.length)).catch((err) =>
            console.error('[vid2context] could not save to history', err),
          );
        } catch (err) {
          if (isAbort(err)) {
            setStates((s) => ({ ...s, [ref.id]: { status: 'idle' } }));
            return;
          }
          setStates((s) => ({ ...s, [ref.id]: { status: 'error', error: toAppError(err) } }));
        }
      },
      ac.signal,
    );
    setRunning(false);
  };

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
          {total > 0 && (
            <div className="space-y-1 border-b border-border px-4 py-3">
              <ProgressBar value={(finished / total) * 100} label="Batch progress" />
              <p className="text-xs text-muted" role="status" aria-live="polite">
                {finished} of {total} done{running ? `, up to ${CONCURRENCY} at a time` : ''}
              </p>
            </div>
          )}
          <ul className="divide-y divide-border" data-testid="batch-items">
            {items.map((ref, i) => {
              const s = states[ref.id] ?? { status: 'idle' };
              const input = refInput(ref);
              const title = s.status === 'done' ? s.context.metadata.title : input;
              const open = runSearch({ ...params, url: input });
              return (
                <li key={ref.id} className="px-4 py-3">
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
                      <p className="truncate text-sm text-fg">
                        <span className="mr-2 text-muted tabular-nums">{i + 1}.</span>
                        {s.status === 'done' ? (
                          <a href={appHref(open)} onClick={(e) => onAppLinkClick(e, open)} className="underline-offset-4 hover:underline">
                            {title}
                          </a>
                        ) : (
                          <span className="font-mono text-[0.8125rem]">{title}</span>
                        )}
                      </p>
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
                          <Spinner /> Working
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
