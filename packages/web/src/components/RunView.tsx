/**
 * /app/?url=...: reopen the result from this browser's history when it is
 * there, otherwise fetch it from the API. Lists (playlists, channels, feeds)
 * go to the batch view; failures show the recovery panel (ways to still get
 * the result, best first), never a bare error.
 */
import { type Bundle, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { Hourglass } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { getComments, getContext, isListError } from '../lib/api.ts';
import { isClientOnly, useApiStatus } from '../lib/api-status.tsx';
import { type AppError, isAbort, toAppError } from '../lib/errors.ts';
import { getEntry, putEntry, runKey, summarize } from '../lib/history.ts';
import { type ImportResponse, isImportableInput } from '../lib/imports.ts';
import { contextViaJob } from '../lib/jobs.ts';
import { acceptedKeyNames } from '../lib/recovery.ts';
import { appHref, downloadSearch, navigate, onAppLinkClick, type RunParams, runSearch } from '../lib/route.ts';
import { keysForServer } from '../lib/settings.ts';
import { ClientOnlyNotice } from './ClientOnlyNotice.tsx';
import { ErrorPanel } from './ErrorPanel.tsx';
import { ImportedNotice } from './import/ImportedNotice.tsx';
import { ImportPanel } from './import/ImportPanel.tsx';
import { PlaylistNotice } from './playlist/PlaylistNotice.tsx';
import { RecoveryPanel } from './recovery/RecoveryPanel.tsx';
import { Button, buttonClass, Card, Spinner } from './ui.tsx';

const ResultView = lazy(() => import('./results/ResultView.tsx'));
const BatchView = lazy(() => import('./batch/BatchView.tsx'));

type State =
  | { kind: 'loading'; startedAt: number; progress?: string }
  | {
      kind: 'result';
      context: VideoContext;
      cachedAt?: number;
      notice?: AppError;
      imported?: { saved: boolean; clientOnly: boolean };
    }
  | { kind: 'list' }
  | { kind: 'error'; error: unknown }
  | { kind: 'needs-api' }
  | { kind: 'missing-local' };

export function Loading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 py-10 text-sm text-muted" role="status">
      <Spinner /> {label}
    </p>
  );
}

/** Pipeline stages as a job reports them ("stt", "resolve: youtube:abc"), in plain words. */
const STAGE_WORDS: Record<string, string> = {
  resolve: 'Reading the link',
  metadata: 'Reading the title and details',
  captions: 'Looking for captions',
  audio: 'Getting the audio',
  stt: 'Transcribing the audio',
  video: 'Watching the video with a multimodal model',
  saving: 'Saving the result',
  done: 'Finishing',
};

/** A job progress message for people; unknown messages pass through unchanged. */
export function plainProgress(message: string): string {
  const stage = message.split(':')[0]?.trim() ?? '';
  return STAGE_WORDS[stage] ?? message;
}

/** After this long, the waiting screen offers ways to get the result without waiting. */
export const SLOW_AFTER_SEC = 30;

export function Fetching({
  url,
  lang,
  startedAt,
  progress,
  onImported,
}: {
  url: string;
  lang?: string;
  startedAt: number;
  /** The server's latest progress message (job runs), such as "transcribing the audio". */
  progress?: string;
  /** A transcript got another way while the run was still going: show it and stop waiting. */
  onImported?: (res: ImportResponse) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [showWays, setShowWays] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.round((now - startedAt) / 1000));
  const slow = sec >= SLOW_AFTER_SEC;
  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <Spinner className="mt-0.5 text-accent" />
          <div className="min-w-0 flex-1 space-y-2">
            <h1 className="text-base font-semibold text-fg" role="status">
              Getting context
            </h1>
            <p className="truncate font-mono text-sm text-muted">{url}</p>
            <p className="text-sm text-muted">
              Metadata and captions usually take a few seconds. When a video has no captions, its audio is transcribed, which can
              take a minute or more for long videos.
            </p>
            {progress && (
              <p className="text-sm text-fg" data-testid="run-progress">
                {plainProgress(progress)}
              </p>
            )}
            <p className="text-xs text-muted tabular-nums" aria-hidden>
              {sec} s
            </p>
          </div>
          <Button variant="ghost" onClick={() => navigate('')}>
            Cancel
          </Button>
        </div>
      </Card>
      {slow && (
        <section className="space-y-3 rounded-v2c-lg border border-border bg-surface p-5" data-testid="run-slow">
          <div className="flex items-start gap-3">
            <Hourglass className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              <h2 className="text-sm font-semibold text-fg">Still working</h2>
              <p className="text-sm text-muted">
                This video is probably being transcribed from its audio, which can take several minutes for long videos. You can
                keep waiting; the run carries on. Or get the result another way now, and whichever finishes first is shown.
              </p>
            </div>
          </div>
          {onImported && isImportableInput(url) && (
            <div className="flex flex-wrap gap-2">
              {!showWays && (
                <Button onClick={() => setShowWays(true)} data-testid="run-slow-ways">
                  Get it another way now
                </Button>
              )}
              <a
                href={appHref(downloadSearch(url))}
                onClick={(e) => onAppLinkClick(e, downloadSearch(url))}
                className={buttonClass('ghost')}
              >
                Download the video or audio instead
              </a>
            </div>
          )}
          {showWays && onImported && <ImportPanel url={url} lang={lang} clientOnly={false} onImported={onImported} />}
        </section>
      )}
    </div>
  );
}

/** Only the entries the server accepts. */
function onlyNames(keys: Record<string, string>, names: readonly string[]): Record<string, string> {
  const allowed = new Set(names);
  return Object.fromEntries(Object.entries(keys).filter(([k]) => allowed.has(k)));
}

export function RunView({ params }: { params: RunParams }) {
  const { state: api } = useApiStatus();
  const [state, setState] = useState<State>({ kind: 'loading', startedAt: Date.now() });
  const [refresh, setRefresh] = useState(0);
  /** Keys entered in the recovery panel this visit; sent even when this browser cannot store them. */
  const retryKeys = useRef<Record<string, string>>({});
  const key = runKey(params.url, params.mode, params.lang);

  /** The running fetch, so a transcript imported while it runs can stop it. */
  const running = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    running.current = ac;
    (async () => {
      if (refresh === 0) {
        const cached = await getEntry(key).catch(() => undefined);
        if (ac.signal.aborted) return;
        if (cached) {
          setState({ kind: 'result', context: cached.context, cachedAt: cached.savedAt });
          return;
        }
      }
      if (params.url.startsWith('file:')) {
        setState({ kind: 'missing-local' });
        return;
      }
      if (api.status === 'checking') return;
      if (isClientOnly(api)) {
        setState({ kind: 'needs-api' });
        return;
      }
      setState({ kind: 'loading', startedAt: Date.now() });
      try {
        // Keys the user chose to send (Settings, or the recovery panel) go with the request when the server accepts them.
        const names = acceptedKeyNames(api);
        const keys = { ...(await keysForServer(names)), ...onlyNames(retryKeys.current, names) };
        if (ac.signal.aborted) return;
        const run = { mode: params.mode, lang: params.lang || undefined };
        // Without own keys, run as a server job: progress shows while it works, and a long transcription is not cut off
        // by a proxy's response timeout (about 100 s on Cloudflare). Jobs run later with the server's own keys, so a run
        // that carries the user's keys goes straight to GET /context. Servers without /jobs fall back to it too.
        let context =
          Object.keys(keys).length > 0
            ? await getContext(params.url, run, { signal: ac.signal, keys })
            : await contextViaJob(
                params.url,
                run,
                (p) => {
                  if (!ac.signal.aborted && p.message) {
                    setState((s) => (s.kind === 'loading' ? { ...s, progress: p.message } : s));
                  }
                },
                { signal: ac.signal },
              );
        let notice: AppError | undefined;
        if (params.comments && !context.comments) {
          try {
            context = { ...context, comments: await getComments(params.url, { signal: ac.signal }) };
          } catch (err) {
            if (isAbort(err)) throw err;
            notice = toAppError(err);
          }
        }
        setState({ kind: 'result', context, notice });
      } catch (err) {
        if (isAbort(err)) return;
        setState(isListError(err) ? { kind: 'list' } : { kind: 'error', error: err });
      }
    })();
    return () => ac.abort();
  }, [key, params.url, params.mode, params.lang, params.comments, api, refresh]);

  // An imported transcript is shown like any fetched result, and goes into this browser's history the same way.
  const onImported = useCallback(
    (res: ImportResponse) => {
      // Got it another way while the run was still going: stop waiting for the run.
      running.current?.abort();
      setState({ kind: 'result', context: res.context, imported: { saved: res.saved, clientOnly: isClientOnly(api) } });
    },
    [api],
  );

  const retry = useCallback((keys?: Record<string, string>) => {
    if (keys) retryKeys.current = { ...retryKeys.current, ...keys };
    setRefresh((n) => n + 1);
  }, []);

  const fresh = state.kind === 'result' && state.cachedAt === undefined ? state.context : undefined;
  const onBundle = useCallback(
    (bundle: Bundle) => {
      if (!fresh) return;
      putEntry(summarize(fresh, { input: params.url, mode: params.mode, lang: params.lang }, bundle.files.length)).catch(
        (err) => {
          console.error('[vid2context] could not save the result to history', err);
        },
      );
    },
    [fresh, params],
  );

  switch (state.kind) {
    case 'loading':
      return api.status === 'checking' ? (
        <Loading label="Connecting to the API" />
      ) : (
        <Fetching
          url={params.url}
          lang={params.lang}
          startedAt={state.startedAt}
          progress={state.progress}
          onImported={onImported}
        />
      );
    case 'needs-api':
      return isImportableInput(params.url) ? (
        <div className="space-y-4">
          <ClientOnlyNotice api={api} input={params.url} />
          <ImportPanel url={params.url} lang={params.lang} clientOnly onImported={onImported} />
        </div>
      ) : (
        <ClientOnlyNotice api={api} input={params.url} />
      );
    case 'missing-local':
      return (
        <ErrorPanel
          title="This result is not saved anymore"
          error={
            new Vid2ContextError('not-found', 'This result was transcribed in your browser and is no longer in its history.', {
              hint: 'Drop the file again on the home page to transcribe it again.',
            })
          }
        />
      );
    case 'error':
      return <RecoveryPanel params={params} error={state.error} onRetry={retry} onImported={onImported} />;
    case 'list':
      return (
        <Suspense fallback={<Loading label="Loading" />}>
          <BatchView params={params} />
        </Suspense>
      );
    case 'result':
      return (
        <Suspense fallback={<Loading label="Loading the result viewer" />}>
          <ResultView
            context={state.context}
            params={params}
            cachedAt={state.cachedAt}
            onRefresh={params.url.startsWith('file:') ? undefined : () => setRefresh((n) => n + 1)}
            onBundle={onBundle}
            notices={
              <>
                <PlaylistNotice
                  input={params.url}
                  enabled={api.status !== 'checking' && !isClientOnly(api)}
                  searchFor={(url) => runSearch({ ...params, url })}
                />
                {state.imported && <ImportedNotice {...state.imported} />}
                {state.notice && (
                  <ErrorPanel title="Comments could not be fetched" error={state.notice}>
                    <p className="text-sm text-muted">The rest of the result is complete.</p>
                  </ErrorPanel>
                )}
              </>
            }
          />
        </Suspense>
      );
  }
}
