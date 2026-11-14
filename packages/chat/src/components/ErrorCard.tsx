/**
 * An answer that failed: the message, the hint that says how to recover, a
 * "Show details" disclosure with every attempt (which rung was tried and why
 * it failed) and the raw error as JSON, a retry button and, when the caller
 * allows it, a close button. Never a bare "something went wrong".
 */
import { ChevronDown, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { ChatErrorData } from '../lib/types.ts';
import { Button, cx, IconButton } from './ui.tsx';

const OUTCOME_LABEL: Record<string, string> = { ok: 'ok', skipped: 'skipped', empty: 'empty', error: 'failed' };

export function ErrorCard(props: { error: ChatErrorData; onRetry?: () => void; onDismiss?: () => void }) {
  const { error } = props;
  const attempts = error.attempts ?? [];
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div role="alert" className="overflow-hidden rounded-v2c-lg border border-border bg-surface text-sm">
      <div className="flex items-start gap-2.5 px-4 py-3">
        <TriangleAlert size={17} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg">
            {error.message} <span className="font-mono text-xs text-muted">({error.code})</span>
          </p>
          {error.hint ? <p className="mt-1 text-muted">{error.hint}</p> : null}
        </div>
        {props.onDismiss ? (
          <IconButton label="Dismiss error" tip={false} className="-mr-1.5 -mt-1 h-7 w-7 shrink-0" onClick={props.onDismiss}>
            <X size={15} aria-hidden />
          </IconButton>
        ) : null}
      </div>
      <div className="border-t border-dashed border-border px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 rounded-v2c-sm py-1 pr-1.5 text-sm text-muted hover:text-fg"
          >
            {open ? 'Hide details' : 'Show details'}
            {attempts.length > 0 ? (
              <span className="text-xs text-subtle">
                ({attempts.length} {attempts.length === 1 ? 'attempt' : 'attempts'})
              </span>
            ) : null}
            <ChevronDown size={14} className={cx('transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
          {props.onRetry ? (
            <Button className="ml-auto px-3 py-1 text-xs" onClick={props.onRetry}>
              <RotateCcw size={13} aria-hidden /> Retry
            </Button>
          ) : null}
        </div>
        {open ? (
          <div id={detailsId} className="mt-2 space-y-3 pb-1">
            {attempts.length > 0 ? (
              <div className="v2c-scroll overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="text-muted">
                      <th className="py-1 pr-3 font-medium">Model</th>
                      <th className="py-1 pr-3 font-medium">Result</th>
                      <th className="py-1 pr-3 font-medium">Reason</th>
                      <th className="py-1 font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((a, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a rung can appear twice (skipped, then tried).
                      <tr key={`${a.id}-${i}`} className="border-t border-border align-top">
                        <td className="py-1.5 pr-3 font-mono">{a.id}</td>
                        <td className="py-1.5 pr-3">{OUTCOME_LABEL[a.outcome] ?? a.outcome}</td>
                        <td className="py-1.5 pr-3 font-mono">{a.reason ?? ''}</td>
                        <td className="py-1.5 break-words text-muted">
                          {a.detail ?? ''}
                          {a.ms !== undefined ? ` (${Math.round(a.ms)} ms)` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <pre className="v2c-scroll overflow-x-auto rounded-v2c-sm bg-surface-2 p-3 font-mono text-xs leading-relaxed text-fg">
              {JSON.stringify(error, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
