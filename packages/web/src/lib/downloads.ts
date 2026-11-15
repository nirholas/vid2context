/**
 * The /downloads routes of the HTTP API as the web app uses them. The server
 * runs yt-dlp and ffmpeg; the browser picks options, starts a job, polls its
 * progress and saves the finished file straight from the API (a plain link,
 * so large files stream to disk instead of being held in memory).
 */
import type { CaptionTracks, DownloadJob, MediaOptions, RawDownloadRequest, TaskJob } from '@vid2context/downloads';
import { apiBase, apiUrl, type CallOptions, requestJson } from './api.ts';

export type { AudioChoice, CaptionTracks, DownloadJob, MediaOptions, TaskJob, VideoChoice } from '@vid2context/downloads';
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
  /** Image formats GET /downloads/thumbnail can return. */
  thumbnailFormats?: string[];
  ytdlp?: string;
}

/** One caption output format the server offers. Older servers send only id and label. */
export interface CaptionFormatInfo {
  id: string;
  label: string;
  timed?: boolean | string;
  bilingual?: boolean;
}

/** A download (video or audio) or a toolkit task (captions, frames, clip, batch): one job API serves both. */
export type AnyJob = DownloadJob | TaskJob;

/** GET /downloads/toolkit: what the media toolkit offers here, with its defaults and limits. */
export interface ToolkitInfo {
  enabled: boolean;
  reason?: string;
  captions: {
    /** `timed`: the format has subtitle times (offset and line layout apply). `bilingual`: it can show a second language. */
    formats: CaptionFormatInfo[];
    modes: string[];
    via: string[];
    defaults: { format: string; mode: string };
    maxTracks: number;
    /** Allowed ranges for the line layout inputs (newer servers). */
    layout?: { maxLineChars: { min: number; max: number }; maxLines: { min: number; max: number } };
  };
  frames: { formats: string[]; defaults: { format: string; quality: string }; maxFrames: number };
  clips: {
    formats: string[];
    defaults: { format: string; fps: number; width: number; lengthSec: number };
    maxSec: number;
    maxWidth: number;
    maxFps: number;
  };
  batch: { kinds: string[]; maxItems: number };
}

/** GET /downloads/toolkit. Older servers without the toolkit answer 404, which callers treat as "off". */
export function getToolkit(call: CallOptions = {}): Promise<ToolkitInfo> {
  return requestJson<ToolkitInfo>('GET', '/downloads/toolkit', {}, undefined, call);
}

/** GET /downloads/captions/tracks: every caption track of one video, its translation targets and the output formats. */
export function getCaptionTracks(url: string, call: CallOptions = {}): Promise<CaptionTracks> {
  return requestJson<CaptionTracks>('GET', '/downloads/captions/tracks', { url }, undefined, call);
}

/** The toolkit routes, by what they make. */
export type TaskRoute = 'captions' | 'frames' | 'clips' | 'batch';

/** POST /downloads/{captions,frames,clips,batch}: start a task; the server answers 202 with it. */
export function startTask(route: TaskRoute, body: Record<string, unknown>, call: CallOptions = {}): Promise<TaskJob> {
  return requestJson<TaskJob>('POST', `/downloads/${route}`, {}, body, call);
}

/** The video's thumbnail as an image file (GET /downloads/thumbnail), saved by the browser from a plain link. */
export function thumbnailUrl(url: string, format = 'jpg', inline = false, base = apiBase()): string {
  return apiUrl('/downloads/thumbnail', { url, format, ...(inline ? { inline: '1' } : {}) }, base);
}

/** One chapter file of a download split by chapters (`?part=N`, 0-based). */
export function downloadPartUrl(id: string, part: number, base = apiBase()): string {
  return apiUrl(`/downloads/${encodeURIComponent(id)}/file`, { part: String(part) }, base);
}

/** Item `n` (0-based) of a batch saved without a .zip. */
export function downloadItemUrl(id: string, n: number, inline = false, base = apiBase()): string {
  return apiUrl(`/downloads/${encodeURIComponent(id)}/items/${n}/file`, inline ? { inline: '1' } : {}, base);
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
export function getDownloadJob<J extends AnyJob = AnyJob>(id: string, call: CallOptions = {}): Promise<J> {
  return requestJson<J>('GET', `/downloads/${encodeURIComponent(id)}`, {}, undefined, call);
}

/** DELETE /downloads/:id: cancel a running job or delete a finished file. */
export function deleteDownload(id: string, call: CallOptions = {}): Promise<{ deleted: boolean; id: string }> {
  return requestJson('DELETE', `/downloads/${encodeURIComponent(id)}`, {}, undefined, call);
}

/** The finished file. `inline` asks the server to let the browser play it instead of saving it. */
export function downloadFileUrl(id: string, inline = false, base = apiBase()): string {
  return apiUrl(`/downloads/${encodeURIComponent(id)}/file`, inline ? { inline: '1' } : {}, base);
}

export function isFinished(job: Pick<AnyJob, 'status'>): boolean {
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
  'Burn subtitles': 'Burning in subtitles',
  Listing: 'Listing the videos',
  Frames: 'Grabbing frames',
  GIF: 'Making the GIF',
  WebP: 'Making the WebP',
  Zip: 'Packing the .zip',
};

/** A readable processing step: "Merging video and audio", "Captions (de)", "Item 2 of 5: Converting audio". */
export function stepLabel(step: string): string {
  const batch = /^(\d+)\/(\d+)(?:\s+(.+))?$/.exec(step);
  if (batch) return `Item ${batch[1]} of ${batch[2]}${batch[3] ? `: ${stepLabel(batch[3])}` : ''}`;
  const captions = /^Captions\s+(\S+)(?:\s+\((.+)\))?$/.exec(step);
  if (captions) {
    const lang = captions[1] === 'default' ? 'spoken language' : captions[1];
    return `Captions (${lang}${captions[2] ? `, ${captions[2]}` : ''})`;
  }
  return STEPS[step] ?? step;
}

/** One line describing where a job is: "Downloading 38%", "Merging video and audio 40%". */
export function phaseLabel(job: Pick<AnyJob, 'status' | 'progress'>): string {
  const p = job.progress;
  if (job.status === 'queued') return 'Waiting for a free slot';
  if (job.status === 'canceled') return 'Canceled';
  if (job.status === 'error') return 'Failed';
  if (job.status === 'done') return 'Ready';
  // The percentage is the current step's own progress, and absent while unknown.
  const pct = p.percent !== undefined ? ` ${Math.round(p.percent)}%` : '';
  if (p.phase === 'processing') return `${p.step ? stepLabel(p.step) : 'Processing'}${pct}`;
  if (p.phase === 'downloading') return `Downloading${pct}`;
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
  /** One subtitle language to burn into the picture (always visible, re-encodes), or '' for none. */
  burnSubtitles: string;
  /** Also save one file per chapter. */
  splitChapters: boolean;
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
  burnSubtitles: '',
  splitChapters: false,
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
    : { ...s, kind, format: 'mp3', quality: 'best', subtitles: '', burnSubtitles: '' };
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
  if (s.kind === 'video' && s.burnSubtitles) body.burnSubtitles = s.burnSubtitles;
  // A chapter split needs the whole video: the chapter times would not fit a trimmed part.
  if (s.splitChapters && s.part === 'all') body.splitChapters = true;
  if (s.removeSponsors) body.removeSegments = [...SPONSOR_SWITCH];
  return body;
}
