/**
 * The timed transcript: each line opens the source at that moment, a chapter
 * jump list, and search with highlights and next/previous.
 */
import { type Chapter, formatTimestamp, type Segment, timestampUrl, type VideoContext } from '@vid2context/core';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Fragment, type ReactNode, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../ui.tsx';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive search across segments. Returns, per segment, the [start, end) ranges that match. */
export function findMatches(segments: Segment[], query: string): Map<number, [number, number][]> {
  const out = new Map<number, [number, number][]>();
  const q = query.trim();
  if (!q) return out;
  const re = new RegExp(escapeRegExp(q), 'gi');
  segments.forEach((s, i) => {
    const ranges: [number, number][] = [];
    for (const m of s.text.matchAll(re)) {
      if (m.index !== undefined) ranges.push([m.index, m.index + m[0].length]);
    }
    if (ranges.length) out.set(i, ranges);
  });
  return out;
}

function highlight(
  text: string,
  ranges: [number, number][] | undefined,
  currentKey: string | undefined,
  segIndex: number,
): ReactNode {
  if (!ranges?.length) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], k) => {
    if (a > at) parts.push(text.slice(at, a));
    const key = `${segIndex}:${k}`;
    parts.push(
      <mark key={key} data-match={key} data-current={currentKey === key ? 'true' : undefined}>
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** Index of the first segment at or after a chapter start. */
export function segmentForChapter(segments: Segment[], ch: Chapter): number {
  const i = segments.findIndex((s) => s.endSec > ch.startSec);
  return i < 0 ? segments.length - 1 : i;
}

export function TranscriptTab({ context }: { context: VideoContext }) {
  const segs = context.transcript.segments;
  const ref = context.metadata.ref;
  const chapters = context.metadata.chapters;
  const long = (context.metadata.durationSec ?? segs.at(-1)?.endSec ?? 0) >= 3600;
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const matches = useMemo(() => findMatches(segs, deferred), [segs, deferred]);
  const keys = useMemo(() => [...matches].flatMap(([i, r]) => r.map((_, k) => `${i}:${k}`)), [matches]);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);
  const searchId = useId();
  const currentKey = keys.length ? keys[Math.min(cursor, keys.length - 1)] : undefined;

  useEffect(() => setCursor(0), [deferred]);
  useEffect(() => {
    if (!currentKey) return;
    listRef.current?.querySelector(`[data-match="${currentKey}"]`)?.scrollIntoView?.({ block: 'center' });
  }, [currentKey]);

  const jumpTo = (i: number) => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-seg="${i}"]`);
    row?.scrollIntoView?.({ block: 'start' });
    row?.querySelector<HTMLElement>('a, [tabindex]')?.focus({ preventScroll: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={searchId} className="sr-only">
          Search the transcript
        </label>
        <div className="relative min-w-0 flex-1 basis-60">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keys.length) {
                e.preventDefault();
                setCursor((c) => (e.shiftKey ? (c - 1 + keys.length) % keys.length : (c + 1) % keys.length));
              }
            }}
            placeholder="Search the transcript"
            className="w-full rounded-v2c border border-border bg-surface-2 py-2 pl-9 pr-3 text-sm text-fg placeholder:text-muted"
          />
        </div>
        <p className="text-sm text-muted tabular-nums" role="status" data-testid="match-count">
          {deferred.trim()
            ? keys.length
              ? `${Math.min(cursor, keys.length - 1) + 1} of ${keys.length} matches`
              : 'No matches'
            : `${segs.length} lines`}
        </p>
        {keys.length > 1 && (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              aria-label="Previous match"
              onClick={() => setCursor((c) => (c - 1 + keys.length) % keys.length)}
            >
              <ChevronUp className="size-4" aria-hidden />
            </Button>
            <Button variant="ghost" aria-label="Next match" onClick={() => setCursor((c) => (c + 1) % keys.length)}>
              <ChevronDown className="size-4" aria-hidden />
            </Button>
          </div>
        )}
      </div>

      {chapters.length > 0 && (
        <nav aria-label="Jump to chapter">
          <ul className="flex flex-wrap gap-2">
            {chapters.map((ch) => (
              <li key={`${ch.startSec}-${ch.title}`}>
                <button
                  type="button"
                  onClick={() => jumpTo(segmentForChapter(segs, ch))}
                  className="rounded-full border border-border bg-surface-2 px-3 py-1 text-xs text-fg hover:border-border-strong"
                >
                  <span className="font-mono text-muted">{formatTimestamp(ch.startSec, long)}</span> {ch.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <ol ref={listRef} className="max-h-[40rem] space-y-1 overflow-y-auto pr-1" aria-label="Transcript" data-testid="transcript">
        {segs.map((s, i) => {
          const ts = formatTimestamp(s.startSec, long);
          const url = timestampUrl(ref, s.startSec);
          return (
            <li
              // Segments have no id; their order is fixed.
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is never reordered
              key={i}
              data-seg={i}
              className="grid grid-cols-[4.5rem_1fr] gap-3 rounded-v2c-sm px-2 py-1 text-sm leading-relaxed hover:bg-surface-2"
            >
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs leading-6 text-accent underline-offset-4 hover:underline"
                  aria-label={`${ts}, open the video at this moment`}
                >
                  {ts}
                </a>
              ) : (
                <span className="font-mono text-xs leading-6 text-muted">{ts}</span>
              )}
              <span className="text-fg">
                {s.speaker && <span className="mr-1 font-semibold">{s.speaker}:</span>}
                <Fragment>{highlight(s.text, matches.get(i), currentKey, i)}</Fragment>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
