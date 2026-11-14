/**
 * A citation chip, "Title @ m:ss", for one [n] marker. Clicking it opens the
 * source panel at that moment. A number with no matching source renders as
 * the plain marker, so a model's stray [9] is visible but not clickable.
 */
import { formatTimestamp } from '@vid2context/core';
import { PlayCircle } from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';
import { chipLabel, sourceByNumber, splitCitations } from '../lib/citations.ts';
import type { ChatSource } from '../lib/types.ts';

export interface CitationScope {
  sources: ChatSource[] | undefined;
  onOpen: (source: ChatSource) => void;
}

/** Lets chips deep inside rendered Markdown reach the message's sources and the panel opener. */
export const CitationContext = createContext<CitationScope | null>(null);

export function CitationChip(props: { source: ChatSource; onOpen: (s: ChatSource) => void }) {
  const s = props.source;
  return (
    <button
      type="button"
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-pill border border-border-strong bg-surface-2 px-2 py-px align-baseline text-[0.8em] font-medium text-fg hover:border-accent hover:bg-surface-3"
      aria-label={`Source ${s.n}: ${s.title} at ${formatTimestamp(s.startSec)}. Open the video at this moment`}
      data-cite={s.n}
      onClick={() => props.onOpen(s)}
    >
      <PlayCircle size={12} className="shrink-0 text-accent" aria-hidden />
      <span className="truncate">{chipLabel(s)}</span>
    </button>
  );
}

/** Chips for a marker like [1, 3]. */
export function CitationGroup(props: { ns: number[]; raw: string }) {
  const scope = useContext(CitationContext);
  const known = props.ns.map((n) => sourceByNumber(scope?.sources, n));
  if (!scope || known.every((s) => !s)) return <>{props.raw}</>;
  return (
    <>
      {props.ns.map((n, i) => {
        const s = known[i];
        // A marker may repeat a number ([2, 2]) and never reorders, so the position is a stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        if (s) return <CitationChip key={`${n}-${i}`} source={s} onOpen={scope.onOpen} />;
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        return <span key={`${n}-${i}`}>[{n}]</span>;
      })}
    </>
  );
}

/** Plain text with chips, used while the Markdown renderer loads and for user messages. */
export function TextWithCitations(props: { text: string }): ReactNode {
  return (
    <>
      {splitCitations(props.text).map((part, i) =>
        part.kind === 'text' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and re-derived from the same text.
          <span key={i}>{part.text}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and re-derived from the same text.
          <CitationGroup key={i} ns={part.ns} raw={part.raw} />
        ),
      )}
    </>
  );
}
