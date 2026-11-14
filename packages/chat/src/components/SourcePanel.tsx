/**
 * The source panel, opened by clicking a citation chip and loaded on demand.
 * For YouTube it embeds the video from youtube-nocookie.com starting at the
 * cited second (the iframe exists only after that click); other sources get
 * a link. Below, the transcript around the cited range, with the cited lines
 * highlighted and scrolled into view. Chips at the top switch between the
 * other sources the same answer cited.
 */
import { formatTimestamp, sliceSegments, type VideoContext } from '@vid2context/core';
import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toErrorData } from '../lib/api.ts';
import { chipLabel } from '../lib/citations.ts';
import type { ChatErrorData, ChatSource } from '../lib/types.ts';
import { cx, IconButton, Spinner } from './ui.tsx';

/** Seconds of transcript shown before and after the cited range. */
const AROUND_SEC = 60;

export interface SourcePanelProps {
  source: ChatSource;
  /** Every source the answer cited, for switching. */
  sources: ChatSource[];
  loadVideo: (videoId: string, url?: string) => Promise<VideoContext | undefined>;
  onSelect: (source: ChatSource) => void;
  onClose: () => void;
}

/** The YouTube video id of a source, from its id (`youtube:abc`) or its timestamp URL. */
export function youtubeIdOf(source: ChatSource): string | undefined {
  if (source.videoId.startsWith('youtube:')) return source.videoId.slice('youtube:'.length);
  const m = source.url ? /(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(source.url) : null;
  return m?.[1];
}

export function embedUrl(youtubeId: string, startSec: number): string {
  const q = new URLSearchParams({ start: String(Math.max(0, Math.floor(startSec))), autoplay: '1', rel: '0' });
  return `https://www.youtube-nocookie.com/embed/${youtubeId}?${q}`;
}

export default function SourcePanel(props: SourcePanelProps) {
  const { source } = props;
  const [video, setVideo] = useState<VideoContext | undefined>();
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [error, setError] = useState<ChatErrorData | undefined>();
  const highlightRef = useRef<HTMLLIElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const ytId = youtubeIdOf(source);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    setState('loading');
    props
      .loadVideo(source.videoId, source.url)
      .then((v) => {
        if (!live) return;
        setVideo(v);
        setState(v ? 'ready' : 'missing');
      })
      .catch((err) => {
        if (!live) return;
        setError(toErrorData(err));
        setState('error');
      });
    return () => {
      live = false;
    };
  }, [source.videoId, source.url, props.loadVideo]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the cited range or transcript changes.
  useEffect(() => {
    // Scroll only the transcript box, so the video above stays in view.
    const box = transcriptRef.current;
    const line = highlightRef.current;
    // The box is the line's offsetParent (position: relative), so offsetTop is measured from its top.
    if (box && line) box.scrollTop = Math.max(0, line.offsetTop - box.clientHeight / 3);
  }, [state, source.n]);

  const segments = video
    ? sliceSegments(video.transcript.segments, source.startSec - AROUND_SEC, source.endSec + AROUND_SEC)
    : [];
  let firstHit = true;
  const others = props.sources.filter((s, i, arr) => arr.findIndex((x) => x.n === s.n) === i);

  return (
    <aside
      aria-label={`Source: ${source.title}`}
      className="flex h-full min-h-0 flex-col border-l border-border bg-surface"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold" title={source.title}>
            {source.title}
          </h2>
          <p className="font-mono text-xs text-muted">
            [{source.n}] {formatTimestamp(source.startSec)} to {formatTimestamp(source.endSec)}
          </p>
        </div>
        <IconButton label="Close source panel" tip={false} onClick={props.onClose} ref={closeRef}>
          <X size={17} aria-hidden />
        </IconButton>
      </div>

      {others.length > 1 ? (
        <div
          className="v2c-scroll flex gap-1.5 overflow-x-auto border-b border-border px-4 py-2"
          role="toolbar"
          aria-label="Sources cited in this answer"
        >
          {others.map((s) => (
            <button
              key={s.n}
              type="button"
              aria-pressed={s.n === source.n}
              onClick={() => props.onSelect(s)}
              className={cx(
                'shrink-0 rounded-pill border px-2 py-0.5 text-xs',
                s.n === source.n ? 'border-accent bg-surface-3 text-fg' : 'border-border text-muted hover:text-fg',
              )}
            >
              [{s.n}] {formatTimestamp(s.startSec)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 p-4">
          {ytId ? (
            <div className="aspect-video w-full overflow-hidden rounded-md border border-border bg-black">
              <iframe
                key={`${ytId}-${source.startSec}`}
                src={embedUrl(ytId, source.startSec)}
                title={`${source.title}, from ${formatTimestamp(source.startSec)}`}
                className="h-full w-full"
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            </div>
          ) : null}
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 text-sm text-accent underline underline-offset-2"
            >
              Open {chipLabel(source, 40)} <ExternalLink size={13} aria-hidden />
            </a>
          ) : (
            <p className="text-sm text-muted">This source has no link to open.</p>
          )}
        </div>

        <div ref={transcriptRef} className="v2c-scroll relative min-h-0 flex-1 overflow-y-auto border-t border-border px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold text-muted">Transcript around the citation</h3>
          {state === 'loading' ? <Spinner label="Loading transcript" /> : null}
          {state === 'missing' ? (
            <p className="text-sm text-muted">The transcript for this video is not available here.</p>
          ) : null}
          {state === 'error' && error ? (
            <div className="text-sm" role="alert">
              <p>{error.message}</p>
              {error.hint ? <p className="mt-1 text-muted">{error.hint}</p> : null}
            </div>
          ) : null}
          {state === 'ready' ? (
            <ol className="flex flex-col gap-0.5 font-mono text-[0.8rem] leading-relaxed">
              {segments.map((seg, i) => {
                const hit = seg.endSec > source.startSec && seg.startSec < source.endSec;
                const isFirst = hit && firstHit;
                if (isFirst) firstHit = false;
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: segments can share a start time.
                    key={`${seg.startSec}-${i}`}
                    ref={isFirst ? highlightRef : undefined}
                    data-cited={hit || undefined}
                    className={cx('flex gap-3 rounded-sm px-2 py-0.5', hit ? 'bg-accent/15 text-fg' : 'text-muted')}
                  >
                    <span className="shrink-0 select-none text-subtle">{formatTimestamp(seg.startSec)}</span>
                    <span>{seg.text}</span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
