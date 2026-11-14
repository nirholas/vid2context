/**
 * An answer that failed: the message, the hint that says how to recover, and
 * every attempt (which rung was tried and why it failed), with a retry
 * button. Never a bare "something went wrong".
 */
import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { ChatErrorData } from '../lib/types.ts';
import { Button } from './ui.tsx';

const OUTCOME_LABEL: Record<string, string> = { ok: 'ok', skipped: 'skipped', empty: 'empty', error: 'failed' };

export function ErrorCard(props: { error: ChatErrorData; onRetry?: () => void }) {
  const { error } = props;
  const attempts = error.attempts ?? [];
  return (
    <div role="alert" className="rounded-md border border-danger/50 bg-danger/10 p-3.5 text-sm">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg">
            {error.message} <span className="font-mono text-xs text-muted">({error.code})</span>
          </p>
          {error.hint ? <p className="mt-1 text-fg/90">{error.hint}</p> : null}
        </div>
      </div>
      {attempts.length > 0 ? (
        <details className="mt-3" open={attempts.length <= 4}>
          <summary className="cursor-pointer text-xs font-medium text-muted">
            {attempts.length} {attempts.length === 1 ? 'attempt' : 'attempts'}
          </summary>
          <div className="v2c-scroll mt-2 overflow-x-auto">
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
        </details>
      ) : null}
      {props.onRetry ? (
        <div className="mt-3">
          <Button onClick={props.onRetry}>
            <RotateCcw size={14} aria-hidden /> Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
