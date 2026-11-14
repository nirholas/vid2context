/** The Chapters, Metadata, Comments and On screen tabs. */
import { type Comment, formatTimestamp, timestampUrl, type VideoContext } from '@vid2context/core';
import type { ReactNode } from 'react';
import { formatDate, formatDuration } from '../../lib/format.ts';
import { appHref, onAppLinkClick, type RunParams, runSearch } from '../../lib/route.ts';

function Stamp({ context, sec }: { context: VideoContext; sec: number }) {
  const long = (context.metadata.durationSec ?? 0) >= 3600;
  const ts = formatTimestamp(sec, long);
  const url = timestampUrl(context.metadata.ref, sec);
  if (!url) return <span className="font-mono text-xs text-muted">{ts}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-accent underline-offset-4 hover:underline"
      aria-label={`${ts}, open the video at this moment`}
    >
      {ts}
    </a>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-v2c border border-dashed border-border px-4 py-6 text-sm text-muted">{children}</p>;
}

function RerunLink({ params, change, children }: { params?: RunParams; change: Partial<RunParams>; children: ReactNode }) {
  if (!params) return null;
  const search = runSearch({ ...params, ...change });
  return (
    <a href={appHref(search)} onClick={(e) => onAppLinkClick(e, search)} className="text-accent underline underline-offset-4">
      {children}
    </a>
  );
}

export function ChaptersTab({ context }: { context: VideoContext }) {
  const chapters = [...context.metadata.chapters].sort((a, b) => a.startSec - b.startSec);
  if (!chapters.length) {
    return <Empty>No chapters. The video has none, and none were found in its description.</Empty>;
  }
  return (
    <ol className="divide-y divide-border rounded-v2c border border-border" data-testid="chapters">
      {chapters.map((ch, i) => {
        const end = ch.endSec ?? chapters[i + 1]?.startSec ?? context.metadata.durationSec;
        return (
          <li key={`${ch.startSec}-${ch.title}`} className="flex items-baseline gap-3 px-4 py-2.5">
            <Stamp context={context} sec={ch.startSec} />
            <span className="flex-1 text-sm text-fg">{ch.title}</span>
            {end !== undefined && <span className="text-xs text-muted tabular-nums">{formatDuration(end - ch.startSec)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-fg break-words">{children}</dd>
    </div>
  );
}

function extraValue(v: unknown): string {
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function MetadataTab({ context }: { context: VideoContext }) {
  const m = context.metadata;
  const t = context.transcript;
  return (
    <dl className="divide-y divide-border" data-testid="metadata">
      <Row label="Title">{m.title}</Row>
      {m.channel && (
        <Row label="Channel">
          {m.channel.url ? (
            <a href={m.channel.url} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-4 hover:underline">
              {m.channel.name}
            </a>
          ) : (
            m.channel.name
          )}
        </Row>
      )}
      {m.durationSec !== undefined && <Row label="Duration">{formatDuration(m.durationSec)}</Row>}
      {m.publishedAt && <Row label="Published">{formatDate(m.publishedAt)}</Row>}
      {m.language && <Row label="Spoken language">{m.language}</Row>}
      <Row label="Transcript">
        {t.origin}, {t.language}, {t.segments.length} lines, made by <code className="font-mono text-xs">{t.producer}</code>
        {t.model ? ` (${t.model})` : ''}
        {t.translated ? ', machine-translated' : ''}
      </Row>
      <Row label="Id">
        <code className="font-mono text-xs">{m.ref.id}</code>
      </Row>
      {m.ref.url && (
        <Row label="Link">
          <a href={m.ref.url} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-4 hover:underline">
            {m.ref.url}
          </a>
        </Row>
      )}
      {m.isLive && <Row label="Live">Yes</Row>}
      {m.tags?.length ? (
        <Row label="Tags">
          <ul className="flex flex-wrap gap-1.5">
            {m.tags.map((tag) => (
              <li key={tag} className="rounded-full bg-surface-3 px-2 py-0.5 text-xs">
                {tag}
              </li>
            ))}
          </ul>
        </Row>
      ) : null}
      {m.extra &&
        Object.entries(m.extra).map(([k, v]) => (
          <Row key={k} label={k}>
            {extraValue(v)}
          </Row>
        ))}
      {m.description && (
        <Row label="Description">
          <p className="whitespace-pre-wrap">{m.description}</p>
        </Row>
      )}
    </dl>
  );
}

function CommentItem({ c }: { c: Comment }) {
  return (
    <li className="space-y-1">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-semibold text-fg">{c.author}</span>
        {c.isCreator && <span className="rounded-full bg-surface-3 px-1.5 text-xs text-fg">creator</span>}
        {c.isPinned && <span className="rounded-full bg-surface-3 px-1.5 text-xs text-fg">pinned</span>}
        {c.publishedAt && <span className="text-xs text-muted">{formatDate(c.publishedAt)}</span>}
        {c.likes !== undefined && <span className="text-xs text-muted">{c.likes.toLocaleString('en-US')} likes</span>}
      </p>
      <p className="whitespace-pre-wrap text-sm text-fg">{c.text}</p>
      {c.replies?.length ? (
        <ul className="mt-2 space-y-3 border-l border-border pl-4">
          {c.replies.map((r) => (
            <CommentItem key={r.id} c={r} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function CommentsTab({ context, params }: { context: VideoContext; params?: RunParams }) {
  const comments = context.comments ?? [];
  if (!comments.length) {
    return (
      <Empty>
        {context.comments ? (
          'Comments were fetched, but there are none.'
        ) : params?.comments ? (
          'Comments were requested but could not be fetched for this video.'
        ) : (
          <>
            Comments were not requested. <RerunLink params={params} change={{ comments: true }}>Run again with comments</RerunLink>
          </>
        )}
      </Empty>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Viewer comments as fetched: opinions from the public, not part of the video.</p>
      <ul className="space-y-4" data-testid="comments">
        {comments.map((c) => (
          <CommentItem key={c.id} c={c} />
        ))}
      </ul>
    </div>
  );
}

export function VisualTab({ context, params }: { context: VideoContext; params?: RunParams }) {
  const notes = [...(context.visual ?? [])].sort((a, b) => a.atSec - b.atSec);
  if (!notes.length) {
    return (
      <Empty>
        No on-screen notes. A multimodal model writes them when the video is read with the Video model mode.{' '}
        {params?.mode !== 'video' && (
          <RerunLink params={params} change={{ mode: 'video' }}>
            Run again with Video model
          </RerunLink>
        )}
      </Empty>
    );
  }
  return (
    <ol className="space-y-3" data-testid="visual">
      {notes.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: notes have no id and are sorted once
        <li key={i} className="grid grid-cols-[4.5rem_1fr] gap-3">
          <Stamp context={context} sec={n.atSec} />
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted">
              {n.kind} by <code className="font-mono">{n.producer}</code>
            </p>
            <p className={`text-sm text-fg ${n.kind === 'code' ? 'whitespace-pre-wrap font-mono' : 'whitespace-pre-wrap'}`}>{n.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
