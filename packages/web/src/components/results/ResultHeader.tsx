/** Thumbnail, title, channel, duration, date and how the transcript was made. */
import type { VideoContext } from '@vid2context/core';
import { ExternalLink, Film } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { formatDate, formatDuration, type OriginBadge, originBadges, spokenDuration } from '../../lib/format.ts';

const TONE: Record<OriginBadge['tone'], string> = {
  good: 'border-success/50',
  ok: 'border-accent/50',
  warn: 'border-warning/60',
};

export function OriginBadges({ context }: { context: VideoContext }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="How the transcript was made">
      {originBadges(context.transcript).map((b) => (
        <li
          key={b.label}
          title={b.title}
          className={`rounded-full border bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-fg ${TONE[b.tone]}`}
          data-testid="origin-badge"
        >
          {b.label}
          <span className="sr-only">: {b.title}</span>
        </li>
      ))}
    </ul>
  );
}

export function ResultHeader({ context }: { context: VideoContext }) {
  const m = context.metadata;
  const [thumbFailed, setThumbFailed] = useState(false);
  const link = m.ref.url;
  const facts: { key: string; node: ReactNode }[] = [];
  if (m.channel?.name) {
    facts.push({
      key: 'channel',
      node: m.channel.url ? (
        <a href={m.channel.url} target="_blank" rel="noopener noreferrer" className="text-fg underline-offset-4 hover:underline">
          {m.channel.name}
        </a>
      ) : (
        <span className="text-fg">{m.channel.name}</span>
      ),
    });
  }
  if (m.durationSec !== undefined) {
    facts.push({
      key: 'duration',
      node: (
        <span>
          <span aria-hidden>{formatDuration(m.durationSec)}</span>
          <span className="sr-only">Duration {spokenDuration(m.durationSec)}</span>
        </span>
      ),
    });
  }
  if (m.publishedAt) facts.push({ key: 'date', node: <span>Published {formatDate(m.publishedAt)}</span> });
  if (context.transcript.language) facts.push({ key: 'lang', node: <span>Language: {context.transcript.language}</span> });
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="aspect-video w-full shrink-0 overflow-hidden rounded-v2c border border-border bg-surface-2 sm:w-56">
        {m.thumbnailUrl && !thumbFailed ? (
          <img
            src={m.thumbnailUrl}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            className="size-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-subtle">
            <Film className="size-8" aria-hidden />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <h1 className="text-xl font-semibold leading-tight text-fg sm:text-2xl break-words" data-testid="result-title">
          {m.title}
        </h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          {facts.map((f, i) => (
            <span key={f.key} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden>·</span>}
              {f.node}
            </span>
          ))}
        </p>
        <OriginBadges context={context} />
        {link && /^https?:/i.test(link) && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-accent underline-offset-4 hover:underline"
          >
            Open the original <ExternalLink className="size-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>
    </header>
  );
}
