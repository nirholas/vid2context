/**
 * Token meter in the thread header: attached context plus the conversation
 * against the selected model's window. Warns from 80% and suggests a
 * larger-context model that is available.
 */
import { Gauge } from 'lucide-react';
import { formatTokens, type MeterReading } from '../lib/meter.ts';
import { formatContextTokens } from '../lib/models.ts';
import type { ModelRow } from '../lib/types.ts';
import { cx } from './ui.tsx';

export function TokenMeter(props: { reading: MeterReading; modelLabel: string; onSwitch: (row: ModelRow) => void }) {
  const r = props.reading;
  const pct = r.ratio !== undefined ? Math.min(100, Math.round(r.ratio * 100)) : undefined;
  const used = `${r.approx ? '~' : ''}${formatTokens(r.used)}`;
  const label = r.limit ? `${used} / ${formatContextTokens(r.limit)}` : `${used} tokens`;
  const detail = [
    `Context ${formatTokens(r.contextTokens)}`,
    `conversation ${formatTokens(r.conversationTokens)}`,
    r.used > 0 ? 'plus room for the answer' : undefined,
    r.limit ? `${props.modelLabel} holds ${formatContextTokens(r.limit)}` : 'the model did not report its window',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <button
        type="button"
        className={cx(
          'group/meter relative inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1',
          r.level === 'over'
            ? 'border-danger/70 text-danger'
            : r.level === 'warn'
              ? 'border-warning/70 text-warning'
              : 'border-border text-muted',
        )}
        aria-label={`Estimated tokens: ${label}. ${detail}.`}
      >
        <Gauge size={13} aria-hidden />
        <span className="font-mono">{label}</span>
        {pct !== undefined ? (
          <span className="hidden h-1 w-12 overflow-hidden rounded-pill bg-surface-3 sm:inline-block" aria-hidden>
            <span
              className={cx('block h-full', r.level === 'over' ? 'bg-danger' : r.level === 'warn' ? 'bg-warning' : 'bg-accent')}
              style={{ width: `${pct}%` }}
            />
          </span>
        ) : null}
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 top-full z-50 mt-1.5 w-64 rounded-sm border border-border bg-surface-3 p-2 text-fg opacity-0 shadow-pop transition-opacity group-hover/meter:opacity-100 group-focus/meter:opacity-100"
        >
          {detail}.
        </span>
      </button>
      {r.level !== 'ok' && r.level !== 'unknown' ? (
        <span className="hidden min-w-0 items-center gap-1.5 md:inline-flex" role="status">
          <span className={cx('truncate', r.level === 'over' ? 'text-danger' : 'text-warning')}>
            {r.level === 'over' ? 'Too long for this model.' : 'Close to the limit.'}
          </span>
          {r.suggestion ? (
            <button
              type="button"
              className="shrink-0 text-accent underline underline-offset-2"
              onClick={() => r.suggestion && props.onSwitch(r.suggestion)}
            >
              Use {r.suggestion.label} ({formatContextTokens(r.suggestion.contextTokens)})
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
