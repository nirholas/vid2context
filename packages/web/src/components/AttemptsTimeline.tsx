/** "How we got this": every provider and rung that ran, in order, with its outcome and reason. */
import type { Attempt } from '@vid2context/core';
import { CircleCheck, CircleDashed, CircleMinus, CircleX } from 'lucide-react';

const OUTCOME: Record<Attempt['outcome'], { label: string; icon: typeof CircleCheck; color: string }> = {
  ok: { label: 'worked', icon: CircleCheck, color: 'text-success' },
  skipped: { label: 'skipped', icon: CircleMinus, color: 'text-subtle' },
  empty: { label: 'nothing found', icon: CircleDashed, color: 'text-warning' },
  error: { label: 'failed', icon: CircleX, color: 'text-danger' },
};

const STAGE: Record<Attempt['stage'], string> = {
  resolve: 'Understand the input',
  metadata: 'Metadata',
  captions: 'Captions',
  audio: 'Audio',
  stt: 'Speech-to-text',
  video: 'Video model',
  llm: 'Language model',
  embed: 'Embeddings',
  visual: 'On-screen notes',
};

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function AttemptsTimeline({ attempts }: { attempts: Attempt[] }) {
  if (!attempts.length) {
    return <p className="text-sm text-muted">No provider ran before this stopped.</p>;
  }
  return (
    <ol className="relative space-y-3 border-l border-border pl-5" aria-label="Steps tried, in order">
      {attempts.map((a, i) => {
        const o = OUTCOME[a.outcome];
        const Icon = o.icon;
        return (
          // Attempts have no id of their own; order is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is never reordered
          <li key={i} className="relative" data-outcome={a.outcome}>
            <Icon className={`absolute -left-[1.85rem] top-0.5 size-4 bg-surface ${o.color}`} aria-hidden />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-medium text-fg">{STAGE[a.stage] ?? a.stage}</span>
              <code className="font-mono text-xs text-muted break-all">{a.id}</code>
              <span className="text-sm text-muted">
                {o.label}
                {a.reason ? `: ${a.reason}` : ''}
              </span>
              {a.ms !== undefined && <span className="text-xs text-muted">{formatMs(a.ms)}</span>}
            </div>
            {a.detail && <p className="mt-0.5 text-sm text-muted break-words">{a.detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}
