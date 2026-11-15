/**
 * One server-side job (a video or audio download, or a captions, frames,
 * clip or batch task): polls it until it ends, shows the phase, a progress
 * bar, bytes, speed and time left (and each video of a batch), and offers
 * Cancel. When done, JobResult links the files straight from the API.
 * Errors use the same panel as every other failure.
 *
 * A failed poll does not end the view: rate limits (the server allows 120
 * requests a minute per IP, shared by every tab), timeouts and dropped
 * connections are retried with backoff that honours Retry-After, and the
 * view says it is reconnecting. Only a job that is gone, downloads turned
 * off, a refused key, or three minutes without an answer show the error.
 */
import { RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CallOptions } from '../../lib/api.ts';
import {
  type AnyJob,
  deleteDownload,
  formatEta,
  formatSpeed,
  getDownloadJob,
  isFatalPollError,
  isFinished,
  nextPollDelay,
  POLL_GIVE_UP_MS,
  phaseLabel,
} from '../../lib/downloads.ts';
import { fromApiBody } from '../../lib/errors.ts';
import { formatBytes } from '../../lib/format.ts';
import { ErrorPanel } from '../ErrorPanel.tsx';
import { Button, ProgressBar } from '../ui.tsx';
import { JobResult } from './JobResult.tsx';

export const POLL_MS = 700;

export function DownloadJobView({
  job: initial,
  onReset,
  onFinished,
  call = {},
  pollMs = POLL_MS,
  compact = false,
}: {
  job: AnyJob;
  /** Back to the form (after done, error or cancel). */
  onReset?: () => void;
  onFinished?: (job: AnyJob) => void;
  call?: CallOptions;
  pollMs?: number;
  /** One line per job, for playlist lists: no preview. */
  compact?: boolean;
}) {
  const [job, setJob] = useState(initial);
  const [pollError, setPollError] = useState<unknown>();
  /** The latest failed poll while retrying, shown as a reconnecting note. */
  const [retrying, setRetrying] = useState<{ message: string; nextInSec: number } | undefined>();
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
    let failures = 0;
    let failingSince: number | undefined;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      try {
        const next = await getDownloadJob(initial.id, callRef.current);
        if (!live) return;
        failures = 0;
        failingSince = undefined;
        setRetrying(undefined);
        setJob(next);
        if (isFinished(next)) finishedRef.current?.(next);
        else schedule(nextPollDelay({ pollMs, failures: 0, hidden: hidden() }));
      } catch (err) {
        if (!live) return;
        failingSince ??= Date.now();
        if (isFatalPollError(err) || Date.now() - failingSince >= POLL_GIVE_UP_MS) {
          setPollError(err);
          return;
        }
        failures += 1;
        const retryAfterSec = (err as { retryAfterSec?: number }).retryAfterSec;
        const wait = nextPollDelay({ pollMs, failures, retryAfterSec, hidden: hidden() });
        setRetrying({ message: err instanceof Error ? err.message : String(err), nextInSec: Math.ceil(wait / 1000) });
        schedule(wait);
      }
    };
    // Coming back to the tab: poll now instead of waiting out the slower background interval.
    const onVisible = () => {
      if (live && !hidden() && failures === 0) schedule(0);
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    schedule(pollMs);
    return () => {
      live = false;
      clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [initial, pollMs]);

  const cancel = async () => {
    setCanceling(true);
    try {
      await deleteDownload(job.id, callRef.current);
      const canceled: AnyJob = { ...job, status: 'canceled' };
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

  if (job.status === 'done') return <JobResult job={job} call={call} compact={compact} onReset={onReset} />;

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
      {/* The percentage is the current step's real progress; absent while unknown, which shows a moving bar. */}
      <ProgressBar value={p.phase === 'preparing' || p.phase === 'queued' ? undefined : p.percent} label={label} />
      {'items' in job && job.items && job.items.length > 0 && (
        <p className="text-xs text-muted tabular-nums" data-testid="batch-progress">
          {job.items.filter((i) => i.status === 'done').length} of {job.items.length} saved
          {job.items.some((i) => i.status === 'error') ? `, ${job.items.filter((i) => i.status === 'error').length} failed` : ''}
        </p>
      )}
      {retrying && (
        <p className="text-xs text-muted" data-testid="download-reconnecting" aria-live="polite">
          Reconnecting to the server (retry in {retrying.nextInSec} s): {retrying.message}
        </p>
      )}
    </div>
  );
}
