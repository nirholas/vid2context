/**
 * A finished job, by what it made: a video or audio file (with its chapter
 * files when split), caption files, frames, an animated clip, a .zip, or a
 * batch whose videos are saved one by one. Every file is a plain link to the
 * API, so the browser streams it to disk instead of holding it in memory.
 */
import { CheckCircle2, Download, FileArchive, RotateCcw, XCircle } from 'lucide-react';
import type { CallOptions } from '../../lib/api.ts';
import { type AnyJob, downloadFileUrl, downloadItemUrl, downloadPartUrl } from '../../lib/downloads.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { Button, buttonClass } from '../ui.tsx';

const LIST = 'divide-y divide-border rounded-v2c border border-border text-sm';

/** What the save button says: "Save MP4", "Save SRT", "Save ZIP (2 files)". */
export function saveLabel(file: { format: string; entries?: unknown[] }): string {
  const n = file.entries?.length;
  return `Save ${file.format.toUpperCase()}${n ? ` (${n} file${n === 1 ? '' : 's'})` : ''}`;
}

/** Every warning of a job, without repeats: the task's own notes, then the file's. */
export function jobWarnings(job: AnyJob): string[] {
  const own = 'warnings' in job && Array.isArray(job.warnings) ? job.warnings : [];
  return [...new Set([...own, ...(job.file?.warnings ?? [])])];
}

function Warnings({ list }: { list: string[] }) {
  if (list.length === 0) return null;
  return (
    <ul
      className="space-y-1 rounded-v2c border border-border bg-surface-2 px-3 py-2 text-sm text-fg"
      data-testid="download-warnings"
    >
      {list.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}

function Preview({ job, base }: { job: AnyJob; base?: string }) {
  const f = job.file;
  if (!f) return null;
  const inline = downloadFileUrl(job.id, true, base);
  if (f.kind === 'video') {
    return (
      // biome-ignore lint/a11y/useMediaCaption: a preview of the user's own download; captions are embedded in the file when asked for.
      <video
        controls
        preload="metadata"
        src={inline}
        className="max-h-[360px] w-full rounded-v2c bg-black"
        data-testid="download-preview"
      />
    );
  }
  if (f.kind === 'audio') {
    // biome-ignore lint/a11y/useMediaCaption: an audio preview of the user's own download.
    return <audio controls preload="metadata" src={inline} className="w-full" data-testid="download-preview" />;
  }
  if (f.mimeType.startsWith('image/')) {
    return (
      <img
        src={inline}
        alt={`${f.kind === 'animation' ? 'Clip' : 'Frame'} from ${f.title}`}
        className="max-h-[360px] max-w-full rounded-v2c border border-border bg-surface-3"
        data-testid="download-preview"
      />
    );
  }
  return null;
}

function ZipEntries({ entries }: { entries: { name: string; bytes: number }[] }) {
  return (
    <details className="text-sm" data-testid="download-entries">
      <summary className="cursor-pointer text-fg">
        <FileArchive className="mr-1 inline size-4 text-muted" aria-hidden />
        Inside the .zip ({entries.length})
      </summary>
      <ul className={`mt-2 ${LIST}`}>
        {entries.map((e) => (
          <li key={e.name} className="flex items-center gap-3 px-3 py-1.5">
            <span className="min-w-0 flex-1 break-all font-mono text-[0.8125rem] text-fg">{e.name}</span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{formatBytes(e.bytes)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Where each caption file's text came from, so a machine translation or speech-to-text is never mistaken for the creator's. */
function CaptionSources({ tracks }: { tracks: { language: string; origin: string; translated?: boolean; via: string }[] }) {
  const origin = (o: string) =>
    o === 'creator-captions'
      ? "the creator's captions"
      : o === 'auto-captions'
        ? 'automatic captions'
        : o === 'stt'
          ? 'speech-to-text'
          : o.replace(/-/g, ' ');
  return (
    <p className="text-sm text-muted" data-testid="download-tracks">
      {tracks.map((t, i) => (
        <span key={`${t.language}-${t.origin}-${t.translated ? 't' : 'o'}`}>
          {i > 0 ? '; ' : ''}
          <span className="font-mono text-fg">{t.language}</span> from {origin(t.origin)}
          {t.translated ? ', machine-translated' : ''}
        </span>
      ))}
    </p>
  );
}

function BatchItems({ job, base }: { job: AnyJob; base?: string }) {
  const items = 'items' in job ? (job.items ?? []) : [];
  if (items.length === 0) return null;
  return (
    <ol className={LIST} data-testid="batch-items">
      {items.map((it) => (
        <li key={it.index} className="space-y-1 px-3 py-2">
          <div className="flex items-center gap-3">
            {it.status === 'done' ? (
              <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Saved" />
            ) : it.status === 'error' ? (
              <XCircle className="size-4 shrink-0 text-danger" aria-label="Failed" />
            ) : (
              <span className="w-4 shrink-0 text-center text-xs text-subtle">{it.index + 1}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-fg" title={it.input}>
              {it.file?.title ?? it.input}
            </span>
            {it.file && !job.file && (
              <a
                href={downloadItemUrl(job.id, it.index, false, base)}
                download={it.file.filename}
                className={`${buttonClass('secondary')} px-2.5 py-1`}
              >
                <Download className="size-3.5" aria-hidden /> {formatBytes(it.file.bytes)}
              </a>
            )}
          </div>
          {it.error && (
            <p className="pl-7 text-xs text-danger">
              {it.error.message}
              {it.error.hint ? <span className="text-muted"> {it.error.hint}</span> : null}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function JobResult({
  job,
  call = {},
  compact = false,
  onReset,
}: {
  job: AnyJob;
  call?: CallOptions;
  compact?: boolean;
  onReset?: () => void;
}) {
  const f = job.file;
  const parts = f && 'parts' in f ? (f.parts ?? []) : [];
  const tracks = f && 'tracks' in f ? (f.tracks ?? []) : [];
  const entries = f && 'entries' in f ? (f.entries ?? []) : [];
  const again = onReset && (
    <Button variant="ghost" className="ml-auto" onClick={onReset}>
      <RotateCcw className="size-4" aria-hidden /> Download another
    </Button>
  );

  return (
    <div className="space-y-3" data-testid="download-done">
      {f ? (
        <div className="flex flex-wrap items-center gap-3">
          <a
            href={downloadFileUrl(job.id, false, call.base)}
            download={f.filename}
            className={buttonClass('accent')}
            data-testid="download-save"
          >
            <Download className="size-4" aria-hidden /> {saveLabel({ format: f.format, entries })}
          </a>
          <span className="min-w-0 text-sm text-muted">
            <span className="break-all text-fg">{f.filename}</span> ({formatBytes(f.bytes)}
            {f.durationSec ? `, ${formatDuration(f.durationSec)}` : ''})
          </span>
          {again}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg">Each video is saved as its own file. Save the ones you want below.</p>
          {again}
        </div>
      )}
      <Warnings list={jobWarnings(job)} />
      {tracks.length > 0 && <CaptionSources tracks={tracks} />}
      {entries.length > 0 && <ZipEntries entries={entries} />}
      {parts.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted">One file per chapter</p>
          <ol className={LIST} data-testid="download-parts">
            {parts.map((part) => (
              <li key={part.index} className="flex items-center gap-3 px-3 py-1.5">
                <span className="w-12 shrink-0 text-xs text-subtle tabular-nums">{formatDuration(part.fromSec)}</span>
                <span className="min-w-0 flex-1 truncate text-fg">{part.title}</span>
                <a
                  href={downloadPartUrl(job.id, part.index, call.base)}
                  download={part.filename.split('/').at(-1)}
                  className={`${buttonClass('secondary')} px-2.5 py-1`}
                >
                  <Download className="size-3.5" aria-hidden /> {formatBytes(part.bytes)}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
      <BatchItems job={job} base={call.base} />
      {!compact && <Preview job={job} base={call.base} />}
      {job.expiresAt && (
        <p className="text-xs text-subtle">
          The server keeps {f ? 'this file' : 'these files'} until {new Date(job.expiresAt).toLocaleTimeString()}. Save{' '}
          {f ? 'it' : 'them'} before then.
        </p>
      )}
    </div>
  );
}
