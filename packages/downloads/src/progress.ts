/**
 * Turn the lines yt-dlp prints through PROGRESS_TEMPLATES into one progress
 * state. A video download is usually two streams (picture, then sound) that
 * are merged afterwards; the `plan` line carries the total size of both, so
 * the overall percentage does not jump back to zero when the second starts.
 */
import { LINE_PREFIX } from './args.ts';

export type DownloadPhase = 'queued' | 'preparing' | 'downloading' | 'processing' | 'finished';

export interface DownloadProgress {
  phase: DownloadPhase;
  /** 0 to 100 across all streams, when the total size is known. */
  percent?: number;
  downloadedBytes: number;
  /** Total bytes of every stream, exact or estimated. */
  totalBytes?: number;
  /** Bytes per second of the current stream. */
  speedBps?: number;
  /** Seconds left for the current stream. */
  etaSec?: number;
  /** yt-dlp format id(s), e.g. "299+140". */
  formatId?: string;
  /** Name of the step running after the download, e.g. "Merger", "ExtractAudio", "EmbedThumbnail". */
  step?: string;
}

export type ProgressEvent =
  | { type: 'plan'; formatId: string; totalBytes?: number; ext?: string }
  | {
      type: 'download';
      status: string;
      downloadedBytes?: number;
      totalBytes?: number;
      speedBps?: number;
      etaSec?: number;
      formatId?: string;
    }
  | { type: 'postprocess'; status: string; step: string }
  | { type: 'file'; path: string };

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '' || v === 'NA' || v === 'None') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Parse one printed line, or return undefined for anything that is not ours. */
export function parseLine(line: string): ProgressEvent | undefined {
  const s = line.trim();
  if (!s.startsWith(LINE_PREFIX)) return undefined;
  const body = s.slice(LINE_PREFIX.length);
  if (body.startsWith('file:')) return { type: 'file', path: body.slice('file:'.length) };
  const parts = body.split(':');
  switch (parts[0]) {
    case 'plan': {
      const [, formatId = '', size, ext] = parts;
      const totalBytes = num(size);
      return {
        type: 'plan',
        formatId,
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(ext && ext !== 'NA' ? { ext } : {}),
      };
    }
    case 'dl': {
      const [, status = '', done, total, estimate, speed, eta, formatId] = parts;
      const totalBytes = num(total) ?? num(estimate);
      const out: ProgressEvent = { type: 'download', status };
      const d = num(done);
      if (d !== undefined) out.downloadedBytes = d;
      if (totalBytes !== undefined) out.totalBytes = totalBytes;
      const sp = num(speed);
      if (sp !== undefined) out.speedBps = sp;
      const e = num(eta);
      if (e !== undefined) out.etaSec = e;
      if (formatId && formatId !== 'NA') out.formatId = formatId;
      return out;
    }
    case 'pp':
      return { type: 'postprocess', status: parts[1] ?? '', step: parts[2] ?? '' };
    default:
      return undefined;
  }
}

/** Steps yt-dlp runs on every download that are not worth showing. */
const QUIET_STEPS = new Set(['MoveFiles', 'MoveFilesAfterDownload']);

/** Folds events into a DownloadProgress. One tracker per download. */
export class ProgressTracker {
  private plannedTotal?: number;
  private formatId?: string;
  /** Bytes per stream, keyed by format id, so the second stream adds to the first. */
  private readonly streams = new Map<string, { done: number; total?: number }>();
  private state: DownloadProgress = { phase: 'preparing', downloadedBytes: 0 };
  readonly files: string[] = [];

  get progress(): DownloadProgress {
    return this.state;
  }

  /** Apply one event; returns true when the visible progress changed. */
  apply(event: ProgressEvent): boolean {
    switch (event.type) {
      case 'plan':
        this.formatId = event.formatId;
        if (event.totalBytes !== undefined) this.plannedTotal = event.totalBytes;
        this.state = { ...this.state, formatId: event.formatId, ...this.totals() };
        return true;
      case 'download': {
        const key = event.formatId ?? this.formatId ?? 'stream';
        const prev = this.streams.get(key) ?? { done: 0 };
        const done = event.downloadedBytes ?? prev.done;
        this.streams.set(key, { done, total: event.totalBytes ?? prev.total });
        const next: DownloadProgress = {
          ...this.state,
          phase: 'downloading',
          ...this.totals(),
        };
        if (event.speedBps !== undefined) next.speedBps = event.speedBps;
        else delete next.speedBps;
        if (event.etaSec !== undefined) next.etaSec = event.etaSec;
        else delete next.etaSec;
        delete next.step;
        this.state = next;
        return true;
      }
      case 'postprocess': {
        if (QUIET_STEPS.has(event.step) || event.status !== 'started') return false;
        const { speedBps: _s, etaSec: _e, ...rest } = this.state;
        this.state = { ...rest, phase: 'processing', step: event.step, ...this.totals(true) };
        return true;
      }
      case 'file':
        this.files.push(event.path);
        return false;
    }
  }

  /** Mark the download finished. */
  finish(bytes: number): DownloadProgress {
    this.state = {
      phase: 'finished',
      percent: 100,
      downloadedBytes: bytes,
      totalBytes: bytes,
      ...(this.formatId ? { formatId: this.formatId } : {}),
    };
    return this.state;
  }

  private totals(complete = false): Pick<DownloadProgress, 'downloadedBytes' | 'totalBytes' | 'percent'> {
    let done = 0;
    let streamTotal = 0;
    let allKnown = this.streams.size > 0;
    for (const s of this.streams.values()) {
      done += s.done;
      if (s.total === undefined) allKnown = false;
      else streamTotal += s.total;
    }
    // The plan covers every stream; the per-stream totals only those started so far.
    const total = this.plannedTotal !== undefined ? Math.max(this.plannedTotal, done) : allKnown ? streamTotal : undefined;
    if (total === undefined || total <= 0) return { downloadedBytes: done };
    const percent = complete ? 100 : Math.min(99.9, Math.round((done / total) * 1000) / 10);
    return { downloadedBytes: done, totalBytes: total, percent };
  }
}
