/**
 * Shown instead of an error when a run fails: the ways to still get the
 * result come first, best first, each one usable right here. The error
 * itself (message, hint, code, attempts) is folded into "Technical details".
 *
 * The suggestions come from core recovery.ts (the same ones the API, CLI and
 * MCP give). Getting the transcript another way (the extension, a media file,
 * a server download, paste, a subtitle file) is the import panel, shown once
 * where the first of those suggestions ranks.
 */
import type { Recovery, TranscriptMode } from '@vid2context/core';
import { ArrowRight, Compass, ExternalLink, KeyRound, RefreshCw, Terminal } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CallOptions } from '../../lib/api.ts';
import { useOptionalApiStatus } from '../../lib/api-status.tsx';
import { toAppError } from '../../lib/errors.ts';
import { type ImportResponse, isImportableInput } from '../../lib/imports.ts';
import { IMPORT_ACTIONS, plainReason, webRecoveries, webRecoveryContext } from '../../lib/recovery.ts';
import { appHref, navigate, onAppLinkClick, type RunParams, runSearch } from '../../lib/route.ts';
import { addProviderKeys, saveShareKeys } from '../../lib/settings.ts';
import { AttemptsTimeline } from '../AttemptsTimeline.tsx';
import { useDownloadStatus } from '../download/use-download-status.ts';
import { ImportPanel } from '../import/ImportPanel.tsx';
import { Button, buttonClass, Card, CopyButton, Spinner } from '../ui.tsx';

/** The import panel tab that carries out each suggestion; it opens on the best-ranked one. */
const IMPORT_TAB: Partial<Record<Recovery['action'], string>> = {
  'download-media': 'download',
  'from-browser': 'browser',
  'import-transcript': 'paste',
  'local-file': 'media',
};

export interface RecoveryPanelProps {
  params: RunParams;
  error: unknown;
  /**
   * Run the request again. `keys` are keys the user just entered and allowed
   * to send; they go with the retry even when this browser cannot store them.
   */
  onRetry: (keys?: Record<string, string>) => void;
  onImported: (result: ImportResponse) => void;
  /** Lets tests replay recorded responses for the download status check. */
  call?: CallOptions;
}

export function RecoveryPanel({ params, error, onRetry, onImported, call }: RecoveryPanelProps) {
  const api = useOptionalApiStatus()?.state;
  const downloads = useDownloadStatus(call);
  const e = toAppError(error);
  const headingId = useId();
  // Wait for the (cached, one request) download check, so the order and the import panel's first tab are final.
  const checking = downloads.state === 'checking';

  const recoveries = useMemo(() => {
    if (!api) return [];
    const rc = webRecoveryContext(api, params.url, { mode: params.mode, downloads: downloads.state === 'on' });
    return webRecoveries(error, rc);
  }, [api, params.url, params.mode, downloads.state, error]);

  // The import panel covers every "get it another way" suggestion; it appears once, where the first of them ranks.
  const canImport = isImportableInput(params.url);
  const steps: { key: string; recovery: Recovery; covers?: Recovery[] }[] = [];
  for (const r of recoveries) {
    if (canImport && IMPORT_ACTIONS.has(r.action)) {
      const group = steps.find((s) => s.key === 'import');
      if (group) group.covers?.push(r);
      else steps.push({ key: 'import', recovery: r, covers: [r] });
    } else {
      steps.push({ key: r.action, recovery: r });
    }
  }
  // Never a dead end: when nothing more specific applies, trying again always does.
  if (steps.length === 0) {
    steps.push({
      key: 'retry',
      recovery: { action: 'retry', title: 'Try again', detail: 'The service that failed is often back within a minute.' },
    });
  }

  return (
    <section aria-labelledby={headingId} data-testid="recovery-panel" data-error-code={e.code} className="space-y-4">
      <Card className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <Compass className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1">
            <h2 id={headingId} className="text-base font-semibold text-fg">
              Let's get this another way
            </h2>
            <p className="text-sm text-fg" data-testid="recovery-reason">
              {plainReason(e.code, params.url)}
            </p>
            {checking ? (
              <p className="flex items-center gap-2 text-sm text-muted" role="status">
                <Spinner /> Finding the ways that work from here
              </p>
            ) : (
              steps.length > 0 && (
                <p className="text-sm text-muted">
                  {steps.length === 1 ? 'This still works:' : `These still work, best first. Pick any of the ${steps.length}.`}
                </p>
              )
            )}
          </div>
        </div>
      </Card>

      {!checking && steps.length > 0 && (
        <ol className="space-y-3" aria-label="Ways to get the result">
          {steps.map((s, i) => (
            <Step key={s.key} n={i + 1} first={i === 0} recovery={s.recovery} covers={s.covers}>
              <StepBody step={s} params={params} onRetry={onRetry} onImported={onImported} />
            </Step>
          ))}
        </ol>
      )}

      <details className="rounded-v2c border border-border bg-surface p-4" data-testid="recovery-details">
        <summary className="cursor-pointer text-sm font-medium text-fg">Technical details</summary>
        <div className="mt-3 space-y-3">
          <p className="break-words text-sm text-fg" data-testid="error-message">
            {e.message}
          </p>
          {e.hint && (
            <p className="rounded-v2c border border-border bg-surface-2 px-3 py-2 text-sm text-fg" data-testid="error-hint">
              <span className="font-semibold">Hint: </span>
              {e.hint}
            </p>
          )}
          <p className="text-xs text-muted">
            Error code <code className="font-mono">{e.code}</code>
            {e.status ? `, HTTP ${e.status}` : ''}
            {e.retryAfterSec ? `, retry after ${e.retryAfterSec} s` : ''}
          </p>
          {e.attempts.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-fg">What was tried ({e.attempts.length})</h3>
              <AttemptsTimeline attempts={e.attempts} />
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

function Step({
  n,
  first,
  recovery,
  covers,
  children,
}: {
  n: number;
  first: boolean;
  recovery: Recovery;
  covers?: Recovery[];
  children: ReactNode;
}) {
  const titles = covers && covers.length > 1 ? covers.map((c) => c.title) : undefined;
  return (
    <li
      className={`rounded-v2c-lg border bg-surface p-4 sm:p-5 ${first ? 'border-accent/60' : 'border-border'}`}
      data-testid={`recovery-${recovery.action}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
            first ? 'bg-accent text-on-accent' : 'bg-surface-3 text-fg'
          }`}
          aria-hidden
        >
          {n}
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-fg">
              {titles ? 'Download the video, or bring the transcript yourself' : recovery.title}
            </h3>
            {titles ? (
              <ul className="mt-1 list-inside list-disc text-sm text-muted">
                {titles.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">{recovery.detail}</p>
            )}
          </div>
          {children}
        </div>
      </div>
    </li>
  );
}

function StepBody({
  step,
  params,
  onRetry,
  onImported,
}: {
  step: { key: string; recovery: Recovery };
  params: RunParams;
  onRetry: (keys?: Record<string, string>) => void;
  onImported: (result: ImportResponse) => void;
}) {
  const r = step.recovery;
  if (step.key === 'import') {
    return (
      <ImportPanel
        url={params.url}
        lang={params.lang}
        clientOnly={false}
        onImported={onImported}
        initialTab={IMPORT_TAB[r.action]}
      />
    );
  }
  switch (r.action) {
    case 'add-key':
      return <KeyForm recovery={r} onSaved={onRetry} />;
    case 'retry':
      return <RetryAction retryAfterSec={r.retryAfterSec} onRetry={() => onRetry()} />;
    case 'switch-mode':
      return <SwitchMode params={params} mode={r.mode ?? 'auto'} />;
    case 'fix-input':
      return (
        <a href={appHref('')} onClick={(ev) => onAppLinkClick(ev, '')} className={buttonClass('secondary')}>
          Paste another link <ArrowRight className="size-4" aria-hidden />
        </a>
      );
    case 'local-file':
      return (
        <div className="space-y-2">
          {r.command && <Command command={r.command} />}
          <a href={appHref('')} onClick={(ev) => onAppLinkClick(ev, '')} className={buttonClass('secondary')}>
            Drop the file on the home page <ArrowRight className="size-4" aria-hidden />
          </a>
        </div>
      );
    default:
      return r.command ? <Command command={r.command} /> : null;
  }
}

function Command({ command }: { command: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto rounded-v2c border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-fg">
        <Terminal className="size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="whitespace-nowrap">{command}</span>
      </code>
      <CopyButton getText={() => command} label="Copy command" />
    </div>
  );
}

/** Retry now, or count down and retry once by itself when the failure said how long to wait. */
export function RetryAction({ retryAfterSec, onRetry }: { retryAfterSec?: number; onRetry: () => void }) {
  const [left, setLeft] = useState(retryAfterSec && retryAfterSec <= 300 ? retryAfterSec : 0);
  const [auto, setAuto] = useState(left > 0);
  const retried = useRef(false);
  useEffect(() => {
    if (!auto || left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [auto, left]);
  useEffect(() => {
    if (auto && left === 0 && !retried.current) {
      retried.current = true;
      onRetry();
    }
  }, [auto, left, onRetry]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={onRetry} data-testid="recovery-retry-button">
        <RefreshCw className="size-4" aria-hidden /> Try again now
      </Button>
      {auto && left > 0 && (
        <>
          <span className="text-sm text-muted tabular-nums" role="status">
            Trying again by itself in {left} s
          </span>
          <Button variant="ghost" onClick={() => setAuto(false)}>
            Don't
          </Button>
        </>
      )}
    </div>
  );
}

function SwitchMode({ params, mode }: { params: RunParams; mode: TranscriptMode }) {
  return (
    <Button variant="accent" onClick={() => navigate(runSearch({ ...params, mode }))} data-testid="recovery-switch-mode-button">
      Transcribe the audio <ArrowRight className="size-4" aria-hidden />
    </Button>
  );
}

/**
 * Paste a key, save it in this browser, allow sending it to the server, and
 * run again. The server uses it for that request only (X-Vid2Context-Keys).
 * When this browser cannot store keys (a private window, blocked storage),
 * the key still goes with this one retry.
 */
export function KeyForm({ recovery, onSaved }: { recovery: Recovery; onSaved: (keys: Record<string, string>) => void }) {
  const offers = recovery.keys ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [share, setShare] = useState(true);
  const [note, setNote] = useState<string>();
  const [saving, setSaving] = useState(false);
  const shareId = useId();
  const entered = Object.fromEntries(
    Object.entries(values)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v !== ''),
  );
  const filled = Object.keys(entered).length > 0;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!filled) return;
    setSaving(true);
    setNote(undefined);
    let stored = true;
    try {
      await addProviderKeys(entered);
      await saveShareKeys(share);
    } catch (err) {
      stored = false;
      console.error('[vid2context] could not store the key in this browser', err);
    }
    setSaving(false);
    if (share) {
      onSaved(entered);
      return;
    }
    setNote(
      stored
        ? 'Saved in this browser. It is used for work done here, such as transcribing a file on this device; this server will not see it.'
        : 'This browser cannot store keys (storage is blocked), and sending is off, so the key was not kept.',
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="recovery-key-form">
      {offers.map((k) => {
        const id = `key-${k.name}`;
        return (
          <div key={k.name} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <label htmlFor={id} className="text-sm font-medium text-fg">
                {k.service} <code className="font-mono text-xs text-muted">{k.name}</code>
              </label>
              <a
                href={k.signupUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                Get a key{k.free ? ` (${k.free})` : ''} <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
            <p className="text-xs text-muted">Unlocks {k.unlocks}.</p>
            <input
              id={id}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={values[k.name] ?? ''}
              onChange={(ev) => setValues((v) => ({ ...v, [k.name]: ev.target.value }))}
              placeholder="Paste the key"
              className="w-full rounded-v2c border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
            />
          </div>
        );
      })}
      <div className="flex items-start gap-2">
        <input
          id={shareId}
          type="checkbox"
          checked={share}
          onChange={(ev) => setShare(ev.target.checked)}
          className="mt-0.5 size-4 accent-accent"
        />
        <label htmlFor={shareId} className="text-xs text-muted">
          Send my saved keys with requests to this server. It uses them for that request only and never stores them. Keys are
          saved in this browser; change this any time in Settings.
        </label>
      </div>
      {note && (
        <p role="status" className="text-sm text-muted" data-testid="recovery-key-note">
          {note}
        </p>
      )}
      <Button type="submit" variant="accent" disabled={!filled || saving} data-testid="recovery-key-submit">
        <KeyRound className="size-4" aria-hidden /> {saving ? 'Saving' : share ? 'Save and try again' : 'Save in this browser'}
      </Button>
    </form>
  );
}
