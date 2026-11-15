/** State and small pieces every tab of the import panel shares: one import at a time, its progress, its error, cancel. */
import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toAppError } from '../../lib/errors.ts';
import { type ImportRequest, type ImportResponse, type KnownMetadata, runImport } from '../../lib/imports.ts';
import type { MediaStep } from '../../lib/media-import.ts';
import { Button, ProgressBar, Spinner } from '../ui.tsx';

export interface ImportPanelProps {
  /** The video link the run was for. */
  url: string;
  /** The language the run asked for, if any. */
  lang?: string;
  /** No API: build the context in this browser. */
  clientOnly: boolean;
  onImported: (result: ImportResponse) => void;
  /** Tab to open first ('browser', 'media', 'download', 'paste', 'file'); the recovery panel picks its top suggestion. */
  initialTab?: string;
}

export function InlineError({ error }: { error: unknown }) {
  const e = toAppError(error);
  return (
    <div
      role="alert"
      data-testid="import-error"
      className="flex items-start gap-2 rounded-v2c border border-danger/60 bg-surface px-3 py-2 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="break-words text-fg">{e.message}</p>
        {e.hint && <p className="text-muted">{e.hint}</p>}
      </div>
    </div>
  );
}

export type ImportWork = (
  signal: AbortSignal,
  onStep: (step: MediaStep) => void,
) => Promise<{ body: ImportRequest; metadata?: KnownMetadata }>;

export function useImport(props: ImportPanelProps) {
  const [busy, setBusy] = useState('');
  const [percent, setPercent] = useState<number>();
  const [error, setError] = useState<unknown>();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(
    async (label: string, work: ImportWork) => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setError(undefined);
      setBusy(label);
      setPercent(undefined);
      const onStep = (s: MediaStep) => {
        if (ac.signal.aborted) return;
        setBusy(s.label);
        setPercent(s.percent);
      };
      try {
        const { body, metadata } = await work(ac.signal, onStep);
        if (ac.signal.aborted) return;
        onStep({ label: 'Importing the transcript' });
        const result = await runImport(body, { clientOnly: props.clientOnly, metadata, signal: ac.signal });
        if (!ac.signal.aborted) props.onImported(result);
      } catch (err) {
        if (!ac.signal.aborted) setError(err);
      } finally {
        if (abort.current === ac) {
          abort.current = null;
          setBusy('');
          setPercent(undefined);
        }
      }
    },
    [props],
  );
  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setBusy('');
    setPercent(undefined);
  };
  return { busy, percent, error, run, cancel, setError };
}

export type ImportState = ReturnType<typeof useImport>;

export function Busy({ state }: { state: ImportState }) {
  return (
    <div className="space-y-2" data-testid="import-busy">
      <div className="flex flex-wrap items-center gap-3" role="status">
        <Spinner />
        <span className="text-sm text-fg">
          {state.busy}
          {state.percent !== undefined && <span className="tabular-nums text-muted"> {Math.round(state.percent)}%</span>}
        </span>
        <Button variant="ghost" onClick={state.cancel}>
          Cancel
        </Button>
      </div>
      {state.percent !== undefined && <ProgressBar value={state.percent} label={state.busy} />}
    </div>
  );
}
