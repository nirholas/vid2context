/**
 * /app/?url=...: reopen the result from this browser's history when it is
 * there, otherwise fetch it from the API. Lists (playlists, channels, feeds)
 * go to the batch view; failures show the recovery panel (ways to still get
 * the result, best first), never a bare error.
 */
import { type Bundle, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { getComments, getContext, isListError } from '../lib/api.ts';
import { isClientOnly, useApiStatus } from '../lib/api-status.tsx';
import { type AppError, isAbort, toAppError } from '../lib/errors.ts';
import { getEntry, putEntry, runKey, summarize } from '../lib/history.ts';
import { type ImportResponse, isImportableInput } from '../lib/imports.ts';
import { acceptedKeyNames } from '../lib/recovery.ts';
import { navigate, type RunParams } from '../lib/route.ts';
import { keysForServer } from '../lib/settings.ts';
import { ClientOnlyNotice } from './ClientOnlyNotice.tsx';
import { ErrorPanel } from './ErrorPanel.tsx';
import { ImportedNotice } from './import/ImportedNotice.tsx';
import { ImportPanel } from './import/ImportPanel.tsx';
import { RecoveryPanel } from './recovery/RecoveryPanel.tsx';
import { Button, Card, Spinner } from './ui.tsx';

const ResultView = lazy(() => import('./results/ResultView.tsx'));
const BatchView = lazy(() => import('./batch/BatchView.tsx'));

type State =
  | { kind: 'loading'; startedAt: number }
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

function Fetching({ url, startedAt }: { url: string; startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
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
          <p className="text-xs text-muted tabular-nums" aria-hidden>
            {sec} s
          </p>
        </div>
        <Button variant="ghost" onClick={() => navigate('')}>
          Cancel
        </Button>
      </div>
    </Card>
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

  useEffect(() => {
    const ac = new AbortController();
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
        let context = await getContext(
          params.url,
          { mode: params.mode, lang: params.lang || undefined },
          { signal: ac.signal, keys },
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
    (res: ImportResponse) =>
      setState({ kind: 'result', context: res.context, imported: { saved: res.saved, clientOnly: isClientOnly(api) } }),
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
        <Fetching url={params.url} startedAt={state.startedAt} />
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
