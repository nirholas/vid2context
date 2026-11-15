/**
 * The /downloads routes of the HTTP API as the web app uses them. The server
 * runs yt-dlp and ffmpeg; the browser picks options, starts a job, polls its
 * progress and saves the finished file straight from the API (a plain link,
 * so large files stream to disk instead of being held in memory).
 */
import type { DownloadJob, MediaOptions, RawDownloadRequest } from '@vid2context/downloads';
import { apiBase, apiUrl, type CallOptions, requestJson } from './api.ts';

export type { AudioChoice, DownloadJob, MediaOptions, VideoChoice } from '@vid2context/downloads';
export {
  AUDIO_FORMATS,
  type AudioFormat,
  FORMAT_LABELS,
  type MediaKind,
  SPONSOR_CATEGORIES,
  VIDEO_CONTAINERS,
  type VideoContainer,
} from '@vid2context/downloads';

export interface DownloadStatus {
  enabled: boolean;
  /** Why downloads are off here, with how to turn them on. */
  reason?: string;
  notice: string;
  limits: { maxBytes: number; maxDurationSec: number; ttlMin: number };
  formats: { video: { id: string; label: string }[]; audio: { id: string; label: string }[] };
  qualities: { video: string[]; audio: string[] };
  sponsorCategories: string[];
  ytdlp?: string;
}

/** GET /downloads/status: whether this server downloads media, and its limits. */
export function getDownloadStatus(call: CallOptions = {}): Promise<DownloadStatus> {
  return requestJson<DownloadStatus>('GET', '/downloads/status', {}, undefined, call);
}

/** GET /downloads/options: qualities and estimated sizes for one video. */
export function getMediaOptions(url: string, call: CallOptions = {}): Promise<MediaOptions> {
  return requestJson<MediaOptions>('GET', '/downloads/options', { url }, undefined, call);
}

/** The body POST /downloads takes. */
export type DownloadBody = Omit<RawDownloadRequest, 'input'> & { url: string };

/** POST /downloads: start a job; the server answers 202 with it. */
export function startDownload(body: DownloadBody, call: CallOptions = {}): Promise<DownloadJob> {
  return requestJson<DownloadJob>('POST', '/downloads', {}, body, call);
}

/** GET /downloads/:id: the job with its progress. */
export function getDownloadJob(id: string, call: CallOptions = {}): Promise<DownloadJob> {
  return requestJson<DownloadJob>('GET', `/downloads/${encodeURIComponent(id)}`, {}, undefined, call);
}

/** DELETE /downloads/:id: cancel a running job or delete a finished file. */
export function deleteDownload(id: string, call: CallOptions = {}): Promise<{ deleted: boolean; id: string }> {
  return requestJson('DELETE', `/downloads/${encodeURIComponent(id)}`, {}, undefined, call);
}

/** The finished file. `inline` asks the server to let the browser play it instead of saving it. */
export function downloadFileUrl(id: string, inline = false, base = apiBase()): string {
  return apiUrl(`/downloads/${encodeURIComponent(id)}/file`, inline ? { inline: '1' } : {}, base);
}

export function isFinished(job: DownloadJob): boolean {
  return job.status === 'done' || job.status === 'error' || job.status === 'canceled';
}

/** Longest wait between polls after failures. */
export const POLL_MAX_MS = 10_000;
/** Poll interval while the tab is hidden: a background tab must not spend the shared per-IP rate limit. */
export const POLL_HIDDEN_MS = 5_000;
/** Keep retrying a failing poll this long before showing the error. */
export const POLL_GIVE_UP_MS = 3 * 60_000;

/**
 * Milliseconds until the next poll of a running job. After `failures`
 * consecutive failed polls the wait doubles from `pollMs` up to POLL_MAX_MS,
 * and never undercuts a Retry-After the server sent (a 429 from the
 * 120-per-minute rate limit carries one).
 */
export function nextPollDelay(opts: { pollMs: number; failures: number; retryAfterSec?: number; hidden?: boolean }): number {
  const base = opts.hidden ? Math.max(opts.pollMs, POLL_HIDDEN_MS) : opts.pollMs;
  const backoff = opts.failures > 0 ? Math.min(POLL_MAX_MS, base * 2 ** Math.min(opts.failures, 10)) : base;
  const told = opts.retryAfterSec !== undefined && opts.retryAfterSec > 0 ? opts.retryAfterSec * 1000 : 0;
  return Math.max(backoff, told);
}

/**
 * A poll failure retrying cannot fix: the job is gone (expired or deleted),
 * downloads were turned off, or the key is refused. Everything else (rate
 * limits, timeouts, a restarting server, a dropped connection) is retried.
 */
export function isFatalPollError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'not-found' || code === 'unavailable' || code === 'auth' || code === 'bad-request';
}

/** "12.3 MB/s" */
export function formatSpeed(bps: number | undefined): string | undefined {
  if (bps === undefined || !Number.isFinite(bps) || bps <= 0) return undefined;
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}

/** "1 min 5 s left", "12 s left" */
export function formatEta(sec: number | undefined): string | undefined {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return undefined;
  const s = Math.round(sec);
  if (s < 60) return `${s} s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s left`;
  return `${Math.floor(m / 60)} h ${m % 60} min left`;
}

/** Readable names for yt-dlp's postprocessor steps. */
const STEPS: Record<string, string> = {
  Merger: 'Merging video and audio',
  VideoRemuxer: 'Remuxing',
  ExtractAudio: 'Converting audio',
  Metadata: 'Writing tags and chapters',
  EmbedThumbnail: 'Embedding cover art',
  ThumbnailsConvertor: 'Preparing cover art',
  EmbedSubtitle: 'Embedding subtitles',
  SponsorBlock: 'Finding sponsor segments',
  ModifyChapters: 'Cutting sponsor segments',
  Trim: 'Trimming',
  Convert: 'Converting',
  Remux: 'Remuxing',
};

/** One line describing where a job is: "Downloading 38%", "Merging video and audio". */
export function phaseLabel(job: DownloadJob): string {
  const p = job.progress;
  if (job.status === 'queued') return 'Waiting for a free slot';
  if (job.status === 'canceled') return 'Canceled';
  if (job.status === 'error') return 'Failed';
  if (job.status === 'done') return 'Ready';
  if (p.phase === 'processing') return p.step ? (STEPS[p.step] ?? p.step) : 'Processing';
  if (p.phase === 'downloading') return p.percent !== undefined ? `Downloading ${Math.round(p.percent)}%` : 'Downloading';
  return 'Preparing';
}

/** What the download form holds. `quality` is a video limit ('1080') or an mp3 bitrate ('192'). */
export interface DownloadSettings {
  kind: 'video' | 'audio';
  format: string;
  quality: string;
  part: 'all' | 'range' | 'chapter';
  from: string;
  to: string;
  /** Chapter index as a string. */
  chapter: string;
  embedThumbnail: boolean;
  embedMetadata: boolean;
  embedChapters: boolean;
  /** One subtitle language to embed in a video, or '' for none. */
  subtitles: string;
  removeSponsors: boolean;
}

export const DEFAULT_SETTINGS: DownloadSettings = {
  kind: 'video',
  format: 'mp4',
  quality: '1080',
  part: 'all',
  from: '',
  to: '',
  chapter: '0',
  embedThumbnail: true,
  embedMetadata: true,
  embedChapters: true,
  subtitles: '',
  removeSponsors: false,
};

/** SponsorBlock categories the "Cut sponsor segments" switch removes. */
export const SPONSOR_SWITCH = ['sponsor', 'selfpromo', 'interaction'] as const;

/** The best quality the options offer at or below the wanted one, so a 240p video does not ask for 1080. */
export function fitQuality(options: MediaOptions | undefined, kind: 'video' | 'audio', wanted: string): string {
  if (kind === 'audio') return wanted;
  const list = options?.video ?? [];
  if (list.length === 0 || list.some((v) => v.quality === wanted)) return wanted;
  if (wanted === 'best') return 'best';
  const limit = Number(wanted);
  // The list runs best first, and `best` is a real stream too (240p for an old video), so compare picture sizes.
  return list.find((v) => v.height <= limit)?.quality ?? list.at(-1)?.quality ?? 'best';
}

/** Switch between video and audio, keeping sensible formats and qualities. */
export function withKind(s: DownloadSettings, kind: 'video' | 'audio', options?: MediaOptions): DownloadSettings {
  if (s.kind === kind) return s;
  return kind === 'video'
    ? { ...s, kind, format: 'mp4', quality: fitQuality(options, 'video', '1080') }
    : { ...s, kind, format: 'mp3', quality: 'best', subtitles: '' };
}

/** The POST /downloads body for these settings. */
export function buildBody(url: string, s: DownloadSettings): DownloadBody {
  const body: DownloadBody = {
    url,
    kind: s.kind,
    format: s.format,
    // Only mp3 has bitrates; the other audio formats keep or losslessly convert the source.
    quality: s.kind === 'audio' && s.format !== 'mp3' ? 'best' : s.quality,
    embedThumbnail: s.embedThumbnail,
    embedMetadata: s.embedMetadata,
    embedChapters: s.embedChapters,
  };
  if (s.part === 'range') {
    if (s.from.trim()) body.from = s.from.trim();
    if (s.to.trim()) body.to = s.to.trim();
  }
  if (s.part === 'chapter') body.chapter = s.chapter;
  if (s.kind === 'video' && s.subtitles) body.subtitles = [s.subtitles];
  if (s.removeSponsors) body.removeSegments = [...SPONSOR_SWITCH];
  return body;
}
