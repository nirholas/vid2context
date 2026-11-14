/**
 * The API page (/app/?view=api): pick a video (paste a link or take a
 * recommended one), then call any endpoint of the vid2context HTTP API with
 * parameters and bodies built from it, or test every read-only video route
 * at once. The list is the catalog plus whatever the server's /openapi.json
 * adds; routes the server does not serve are marked.
 */
import { BookOpen, CircleCheck, CirclePlay, FileJson, KeyRound, ServerOff, Settings, Square } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CATALOG, type Endpoint, findEndpoint } from '../../lib/api-catalog.ts';
import { isClientOnly, useApiStatus } from '../../lib/api-status.tsx';
import { isAbort } from '../../lib/errors.ts';
import { EXAMPLES } from '../../lib/examples.ts';
import { buildRequest, createdId, type FormState, isMissing, type Merged, mergeOpenApi, varsFor } from '../../lib/playground.ts';
import { type Answer, formatMs, type Outcome, send } from '../../lib/playground-send.ts';
import { type ApiParams, apiSearch, appHref, onAppLinkClick } from '../../lib/route.ts';
import { Button, Card, Spinner } from '../ui.tsx';
import { EndpointList, MethodBadge } from './EndpointList.tsx';
import { EndpointPanel } from './EndpointPanel.tsx';
import { StatusDot } from './ResponseView.tsx';

/** sessionStorage key for the API key: kept for this tab only, never in localStorage. */
export const API_KEY_STORAGE = 'v2c.apiKey';
const DEFAULT_ENDPOINT = 'context';

/** "Test all" order: cheap server routes, then metadata and context (which fills the library), then the rest. */
export function smokeOrder(list: Endpoint[]): Endpoint[] {
  const first = ['health', 'formats', 'models', 'metadata', 'context'];
  const smoke = list.filter((e) => e.smoke && !e.mutates);
  return [
    ...first.map((id) => smoke.find((e) => e.id === id)).filter((e): e is Endpoint => !!e),
    ...smoke.filter((e) => !first.includes(e.id)),
  ];
}

function readKey(): string {
  try {
    return sessionStorage.getItem(API_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

function saveKey(v: string): void {
  try {
    if (v) sessionStorage.setItem(API_KEY_STORAGE, v);
    else sessionStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // Storage blocked: the key lasts until the page reloads.
  }
}

const CHIP =
  'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition focus-visible:outline-2 focus-visible:outline-accent';

function VideoPicker({ video, onVideo }: { video: string; onVideo: (v: string) => void }) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        Video
      </label>
      <input
        id={id}
        type="url"
        inputMode="url"
        value={video}
        onChange={(e) => onVideo(e.target.value)}
        placeholder="https://www.youtube.com/watch?v=..."
        spellCheck={false}
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        className="w-full rounded-v2c border border-border bg-surface-2 px-4 py-2.5 font-mono text-sm text-fg placeholder:text-muted"
        data-testid="api-video"
      />
      <div className="flex flex-wrap items-center gap-2">
        <span id={`${id}-hint`} className="text-xs text-subtle">
          Paste any YouTube link, or use a recommended one:
        </span>
        {EXAMPLES.map((ex) => {
          const active = ex.url === video.trim();
          return (
            <button
              key={ex.url}
              type="button"
              onClick={() => onVideo(ex.url)}
              aria-pressed={active}
              className={`${CHIP} ${active ? 'border-accent bg-surface-2 text-fg' : 'border-border text-muted hover:border-border-strong hover:text-fg'}`}
            >
              {ex.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function KeyField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <details className="group text-sm" open={!!value}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-muted hover:text-fg">
        <KeyRound className="size-4" aria-hidden />
        API key {value ? '(set)' : '(optional)'}
      </summary>
      <div className="mt-2 space-y-1">
        <label htmlFor={id} className="sr-only">
          API key
        </label>
        <input
          id={id}
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Bearer token"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-v2c-sm border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-fg placeholder:text-muted sm:max-w-md"
        />
        <p className="text-xs text-muted">
          Only needed when the server sets VID2CONTEXT_API_KEYS or runs in hosted mode. Sent as Authorization: Bearer, kept in
          this tab only, and never written into copied curl commands (they read $VID2CONTEXT_API_KEY).
        </p>
      </div>
    </details>
  );
}

interface TestRun {
  ids: string[];
  running: boolean;
}

function TestAllResults({
  run,
  endpoints,
  outcomes,
  onOpen,
}: {
  run: TestRun;
  endpoints: Endpoint[];
  outcomes: Record<string, Outcome>;
  onOpen: (id: string) => void;
}) {
  const done = run.ids.filter((id) => outcomes[id]?.state === 'done' || outcomes[id]?.state === 'failed');
  const passed = run.ids.filter((id) => {
    const o = outcomes[id];
    return o?.state === 'done' && o.answer.ok;
  });
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold text-fg">Test all</h2>
        <span className="text-sm text-muted" role="status">
          {run.running ? `${done.length} of ${run.ids.length} done` : `${passed.length} of ${run.ids.length} answered 2xx`}
        </span>
      </div>
      <ul className="divide-y divide-border" data-testid="api-test-all">
        {run.ids.map((id) => {
          const ep = findEndpoint(endpoints, id);
          const o = outcomes[id];
          if (!ep) return null;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onOpen(id)}
                className="flex w-full items-center gap-3 px-1 py-2 text-left text-sm hover:bg-surface-2"
              >
                <MethodBadge method={ep.method} />
                <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{ep.path}</code>
                {o?.state === 'sending' && <Spinner className="text-muted" />}
                {o?.state === 'done' && (
                  <span className="flex items-center gap-2 text-xs text-muted">
                    <StatusDot status={o.answer.status} />
                    <span className="tabular-nums text-fg">{o.answer.status}</span>
                    {o.answer.json && !o.answer.ok
                      ? (o.answer.json as { error?: { code?: string } }).error?.code
                      : formatMs(o.answer.ms)}
                  </span>
                )}
                {o?.state === 'failed' && <span className="text-xs text-danger">no response</span>}
                {o?.state === 'canceled' && <span className="text-xs text-muted">canceled</span>}
                {!o && <span className="text-xs text-subtle">waiting</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function ApiPlayground({ initial = {} }: { initial?: ApiParams }) {
  const { state } = useApiStatus();
  const base = state.base;
  const [video, setVideo] = useState(initial.video ?? EXAMPLES[0]?.url ?? '');
  const [merged, setMerged] = useState<Merged>({ endpoints: CATALOG });
  // Any id is kept: routes merged from the server's OpenAPI document arrive after the first render.
  const [selected, setSelected] = useState(initial.endpoint ?? DEFAULT_ENDPOINT);
  const [forms, setForms] = useState<Record<string, FormState | undefined>>({});
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [lastIds, setLastIds] = useState<Record<string, string>>({});
  const [apiKey, setApiKey] = useState(readKey);
  const [filter, setFilter] = useState('');
  const [testRun, setTestRun] = useState<TestRun>();
  const controllers = useRef(new Map<string, AbortController>());
  const stopAll = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const endpoints = merged.endpoints;
  const ep = findEndpoint(endpoints, selected) ?? findEndpoint(endpoints, DEFAULT_ENDPOINT) ?? endpoints[0];

  // The server's own route list: adds routes the catalog lacks and marks ones it does not serve.
  useEffect(() => {
    if (state.status !== 'online') return;
    const ctl = new AbortController();
    const headers: Record<string, string> = { accept: 'application/json' };
    const key = readKey();
    if (key) headers.authorization = `Bearer ${key}`;
    fetch(`${base}/openapi.json`, { headers, signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => setMerged(mergeOpenApi(CATALOG, doc)))
      .catch((err) => {
        if (!isAbort(err)) console.error('[vid2context] could not read the server OpenAPI document', err);
      });
    return () => ctl.abort();
  }, [state.status, base]);

  // Keep the address shareable without a history entry per click.
  useEffect(() => {
    const q = apiSearch({
      endpoint: ep && ep.id !== DEFAULT_ENDPOINT ? ep.id : undefined,
      video: video.trim() && video.trim() !== EXAMPLES[0]?.url ? video.trim() : undefined,
    });
    history.replaceState(history.state, '', appHref(q));
  }, [ep, video]);

  // Abort everything in flight when the page closes.
  useEffect(() => {
    const map = controllers.current;
    return () => {
      for (const c of map.values()) c.abort();
      stopAll.current?.abort();
    };
  }, []);

  const varsOf = useCallback((e: Endpoint) => varsFor(video, lastIds[e.group] ?? ''), [video, lastIds]);

  const requestOf = useCallback(
    (e: Endpoint) => buildRequest(e, forms[e.id], varsOf(e), base, { file: files[e.id], apiKey }),
    [forms, files, varsOf, base, apiKey],
  );

  const setOutcome = useCallback((id: string, o: Outcome) => setOutcomes((m) => ({ ...m, [id]: o })), []);

  const run = useCallback(
    async (e: Endpoint, outer?: AbortSignal): Promise<Answer | undefined> => {
      const req = requestOf(e);
      if (req.missing.length || req.bodyError) return undefined;
      controllers.current.get(e.id)?.abort();
      const ctl = new AbortController();
      controllers.current.set(e.id, ctl);
      outer?.addEventListener('abort', () => ctl.abort(), { once: true });
      const startedAt = performance.now();
      setOutcome(e.id, { state: 'sending', startedAt });
      try {
        const answer = await send(req, {
          signal: ctl.signal,
          onProgress: (partial) => setOutcome(e.id, { state: 'sending', startedAt, partial }),
        });
        setOutcome(e.id, { state: 'done', answer });
        const created = answer.ok ? createdId(e, answer.json) : undefined;
        if (created) setLastIds((m) => ({ ...m, [created.group]: created.id }));
        return answer;
      } catch (err) {
        const ms = performance.now() - startedAt;
        if (isAbort(err)) setOutcome(e.id, { state: 'canceled', ms });
        else {
          const detail = err instanceof Error ? err.message : String(err);
          setOutcome(e.id, {
            state: 'failed',
            ms,
            message: `Could not reach ${base} (${detail}). Check that the server is running and, when it is on another origin, that VID2CONTEXT_CORS_ORIGINS allows this site.`,
          });
        }
        return undefined;
      } finally {
        if (controllers.current.get(e.id) === ctl) controllers.current.delete(e.id);
      }
    },
    [requestOf, base, setOutcome],
  );

  const testAll = async () => {
    const list = smokeOrder(endpoints).filter((e) => !isMissing(e, merged.served));
    const ctl = new AbortController();
    stopAll.current = ctl;
    setTestRun({ ids: list.map((e) => e.id), running: true });
    setOutcomes((m) => {
      const next = { ...m };
      for (const e of list) delete next[e.id];
      return next;
    });
    for (const e of list) {
      if (ctl.signal.aborted) break;
      await run(e, ctl.signal);
    }
    setTestRun((r) => (r ? { ...r, running: false } : r));
    stopAll.current = null;
  };

  const open = (id: string) => {
    setSelected(id);
    panel.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const changeKey = (v: string) => {
    setApiKey(v);
    saveKey(v);
  };

  const offline = isClientOnly(state);
  const smokeCount = smokeOrder(endpoints).filter((e) => !isMissing(e, merged.served)).length;
  const missing = useMemo(() => (e: Endpoint) => isMissing(e, merged.served), [merged.served]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-fg">API</h1>
        <p className="max-w-3xl text-sm text-muted">
          Try every vid2context endpoint against a real video. Parameters and request bodies fill in from the video you pick, and
          each request can be copied as curl.
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-2">
            {state.status === 'online' ? (
              <CircleCheck className="size-3.5 text-success" aria-hidden />
            ) : state.status === 'checking' ? (
              <Spinner className="size-3.5" />
            ) : (
              <ServerOff className="size-3.5 text-warning" aria-hidden />
            )}
            Sending to <code className="font-mono text-fg">{base}</code>
          </span>
          <a
            href={appHref('?view=settings')}
            onClick={(e) => onAppLinkClick(e, '?view=settings')}
            className="inline-flex items-center gap-1 underline-offset-2 hover:text-fg hover:underline"
          >
            <Settings className="size-3.5" aria-hidden /> Change server
          </a>
          <a
            href={`${base}/openapi.json`}
            className="inline-flex items-center gap-1 underline-offset-2 hover:text-fg hover:underline"
          >
            <FileJson className="size-3.5" aria-hidden /> openapi.json
          </a>
          <a href="/docs/" className="inline-flex items-center gap-1 underline-offset-2 hover:text-fg hover:underline">
            <BookOpen className="size-3.5" aria-hidden /> Docs
          </a>
        </p>
      </header>

      {offline && (
        <Card className="flex items-start gap-3 p-4 text-sm">
          <ServerOff className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="text-fg">
            No vid2context API answered at <code className="font-mono">{base}</code>, so requests will fail.{' '}
            <a
              href={appHref('?view=settings')}
              onClick={(e) => onAppLinkClick(e, '?view=settings')}
              className="underline underline-offset-2"
            >
              Point the app at a running server in Settings
            </a>
            , or start one with <code className="font-mono">npm run start:server</code>.
          </p>
        </Card>
      )}

      <Card className="space-y-4 p-5">
        <VideoPicker video={video} onVideo={setVideo} />
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          {testRun?.running ? (
            <Button onClick={() => stopAll.current?.abort()}>
              <Square className="size-4" aria-hidden /> Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={testAll} disabled={!video.trim()} data-testid="api-test-all-button">
              <CirclePlay className="size-4" aria-hidden /> Test all {smokeCount} read-only endpoints
            </Button>
          )}
          <span className="text-xs text-muted">
            Runs each read-only video and server route once with this video. Routes that change data or need an LLM are left for
            you to send.
          </span>
        </div>
        <KeyField value={apiKey} onChange={changeKey} />
      </Card>

      {testRun && <TestAllResults run={testRun} endpoints={endpoints} outcomes={outcomes} onOpen={open} />}

      <div ref={panel} className="grid scroll-mt-4 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-2 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
          <EndpointList
            endpoints={endpoints}
            selected={ep?.id ?? ''}
            onSelect={setSelected}
            filter={filter}
            onFilter={setFilter}
            outcomes={outcomes}
            missing={missing}
          />
          {merged.served && (
            <p className="mt-4 px-2 text-xs text-subtle max-lg:hidden">
              Listed from this server's OpenAPI document. Browser sign-in and OAuth redirects are left out.
            </p>
          )}
        </div>
        {ep && (
          <EndpointPanel
            key={ep.id}
            ep={ep}
            vars={varsOf(ep)}
            form={forms[ep.id]}
            onForm={(f) => setForms((m) => ({ ...m, [ep.id]: f }))}
            onFile={(f) => setFiles((m) => ({ ...m, [ep.id]: f }))}
            request={requestOf(ep)}
            outcome={outcomes[ep.id]}
            absent={missing(ep)}
            onSend={() => void run(ep)}
            onCancel={() => controllers.current.get(ep.id)?.abort()}
          />
        )}
      </div>
    </div>
  );
}

export default ApiPlayground;
