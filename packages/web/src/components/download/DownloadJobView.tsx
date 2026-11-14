/**
 * One server-side download: polls the job until it ends, shows the phase, a
 * progress bar, bytes, speed and time left, and offers Cancel. When done it
 * links the file straight from the API (the browser streams it to disk) and
 * plays it inline. Errors use the same panel as every other failure.
 */
import { Download, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CallOptions } from '../../lib/api.ts';
import {
  type DownloadJob,
  deleteDownload,
  downloadFileUrl,
  formatEta,
  formatSpeed,
  getDownloadJob,
  isFinished,
  phaseLabel,
} from '../../lib/downloads.ts';
import { fromApiBody } from '../../lib/errors.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { ErrorPanel } from '../ErrorPanel.tsx';
import { Button, buttonClass, ProgressBar } from '../ui.tsx';

export const POLL_MS = 700;

export function DownloadJobView({
  job: initial,
  onReset,
  onFinished,
  call = {},
  pollMs = POLL_MS,
  compact = false,
}: {
  job: DownloadJob;
  /** Back to the form (after done, error or cancel). */
  onReset?: () => void;
  onFinished?: (job: DownloadJob) => void;
  call?: CallOptions;
  pollMs?: number;
  /** One line per job, for playlist lists: no preview. */
  compact?: boolean;
}) {
  const [job, setJob] = useState(initial);
  const [pollError, setPollError] = useState<unknown>();
  const [canceling, setCanceling] = useState(false);
  const callRef = useRef(call);
  callRef.current = call;
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    if (isFinished(initial)) {
      finishedRef.current?.(initial);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await getDownloadJob(initial.id, callRef.current);
        if (!live) return;
        setJob(next);
        if (isFinished(next)) finishedRef.current?.(next);
        else timer = setTimeout(tick, pollMs);
      } catch (err) {
        if (live) setPollError(err);
      }
    };
    timer = setTimeout(tick, pollMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [initial, pollMs]);

  const cancel = async () => {
    setCanceling(true);
    try {
      await deleteDownload(job.id, callRef.current);
      const canceled: DownloadJob = { ...job, status: 'canceled' };
      setJob(canceled);
      finishedRef.current?.(canceled);
    } catch (err) {
      setPollError(err);
    } finally {
      setCanceling(false);
    }
  };

  if (pollError) return <ErrorPanel error={pollError} title="Lost track of the download" onRetry={onReset} />;

  if (job.status === 'error') {
    // Status 0: the job failed on the server, not this request, so no HTTP status is shown.
    const err = fromApiBody({ error: job.error ?? { code: 'upstream', message: 'The download failed.' } }, 0);
    return <ErrorPanel error={err} title="The download failed" onRetry={onReset} />;
  }

  const p = job.progress;
  const running = job.status === 'queued' || job.status === 'running';
  const label = phaseLabel(job);

  if (job.status === 'done' && job.file) {
    const f = job.file;
    const url = downloadFileUrl(job.id, false, call.base);
    const inline = downloadFileUrl(job.id, true, call.base);
    return (
      <div className="space-y-3" data-testid="download-done">
        <div className="flex flex-wrap items-center gap-3">
          <a href={url} download={f.filename} className={buttonClass('accent')} data-testid="download-save">
            <Download className="size-4" aria-hidden /> Save {f.format.toUpperCase()}
          </a>
          <span className="min-w-0 text-sm text-muted">
            <span className="break-all text-fg">{f.filename}</span> ({formatBytes(f.bytes)}
            {f.durationSec ? `, ${formatDuration(f.durationSec)}` : ''})
          </span>
          {onReset && (
            <Button variant="ghost" className="ml-auto" onClick={onReset}>
              <RotateCcw className="size-4" aria-hidden /> Download another
            </Button>
          )}
        </div>
        {f.warnings.length > 0 && (
          <ul
            className="space-y-1 rounded-v2c border border-border bg-surface-2 px-3 py-2 text-sm text-fg"
            data-testid="download-warnings"
          >
            {f.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {!compact &&
          (f.kind === 'video' ? (
            // biome-ignore lint/a11y/useMediaCaption: a preview of the user's own download; captions are embedded in the file when asked for.
            <video
              controls
              preload="metadata"
              src={inline}
              className="max-h-[360px] w-full rounded-v2c bg-black"
              data-testid="download-preview"
            />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: an audio preview of the user's own download.
            <audio controls preload="metadata" src={inline} className="w-full" data-testid="download-preview" />
          ))}
        {job.expiresAt && (
          <p className="text-xs text-subtle">
            The server keeps this file until {new Date(job.expiresAt).toLocaleTimeString()}. Save it before then.
          </p>
        )}
      </div>
    );
  }

  if (job.status === 'canceled') {
    return (
      <div className="flex items-center gap-3 text-sm text-muted" data-testid="download-canceled">
        Canceled.
        {onReset && (
          <Button variant="ghost" onClick={onReset}>
            <RotateCcw className="size-4" aria-hidden /> Start again
          </Button>
        )}
      </div>
    );
  }

  const details = [
    p.totalBytes
      ? `${formatBytes(p.downloadedBytes)} of ${formatBytes(p.totalBytes)}`
      : p.downloadedBytes
        ? formatBytes(p.downloadedBytes)
        : undefined,
    p.phase === 'downloading' ? formatSpeed(p.speedBps) : undefined,
    p.phase === 'downloading' ? formatEta(p.etaSec) : undefined,
  ].filter(Boolean);

  return (
    <div className="space-y-2" data-testid="download-progress" aria-busy={running}>
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-fg" role="status">
          {label}
        </span>
        {details.length > 0 && <span className="text-xs text-muted tabular-nums">{details.join(' · ')}</span>}
        <Button variant="ghost" className="ml-auto px-2 py-1" onClick={cancel} disabled={canceling}>
          <X className="size-4" aria-hidden /> Cancel
        </Button>
      </div>
      <ProgressBar value={p.phase === 'downloading' || p.phase === 'finished' ? p.percent : undefined} label={label} />
    </div>
  );
}
