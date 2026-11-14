/**
 * yt-dlp arguments for a download. Pure functions so tests can assert the
 * exact argv. The format rules were checked against real YouTube format
 * lists (see test/fixtures/README.md):
 *
 * - `channels:2` keeps the stereo track. Without it yt-dlp prefers 5.1 AAC or
 *   AC-3 tracks, which many players and phones handle badly.
 * - mp4 prefers H.264 (`vcodec:h264`) up to the requested size, so the file
 *   plays everywhere; above 1080p YouTube has only VP9 and AV1, which mp4
 *   also holds.
 * - webm prefers VP9 + Opus; mkv takes the best streams in any codec.
 * - m4a and opus copy the original stream when the site has one (no re-encode).
 */
import { type AudioFormat, type DownloadRequest, isVideoContainer, type VideoContainer } from './options.ts';

/** Prefix of every line this package asks yt-dlp to print, so other output is never mistaken for progress. */
export const LINE_PREFIX = 'v2c:';

export const PROGRESS_TEMPLATES = [
  '--progress-template',
  'download:v2c:dl:%(progress.status)s:%(progress.downloaded_bytes)s:%(progress.total_bytes)s:%(progress.total_bytes_estimate)s:%(progress.speed)s:%(progress.eta)s:%(info.format_id)s',
  '--progress-template',
  'postprocess:v2c:pp:%(progress.status)s:%(progress.postprocessor)s',
  '--print',
  'before_dl:v2c:plan:%(format_id)s:%(filesize,filesize_approx)s:%(ext)s',
  '--print',
  'after_move:v2c:file:%(filepath)s',
];

export interface FormatChoice {
  /** -f */
  format: string;
  /** -S */
  sort: string;
}

function resLimit(quality: string): string {
  return quality === 'best' ? 'res' : `res:${quality}`;
}

/** The -f and -S values for a request. */
export function formatChoice(req: Pick<DownloadRequest, 'kind' | 'format' | 'quality'>): FormatChoice {
  if (req.kind === 'video') {
    const res = resLimit(req.quality);
    const sort: Record<VideoContainer, string> = {
      mp4: `${res},vcodec:h264,channels:2,acodec:aac`,
      webm: `${res},vcodec:vp9,channels:2,acodec:opus`,
      mkv: `${res},channels:2`,
    };
    return { format: 'bv*+ba/b', sort: sort[req.format as VideoContainer] };
  }
  const sort: Record<AudioFormat, string> = {
    mp3: 'channels:2',
    m4a: 'channels:2,acodec:aac',
    opus: 'channels:2,acodec:opus',
    flac: 'channels:2',
    wav: 'channels:2',
  };
  return { format: 'ba/b', sort: sort[req.format as AudioFormat] };
}

/** yt-dlp's --audio-quality for a request: 0 is the best VBR, `192K` a fixed bitrate. */
export function audioQualityArg(req: Pick<DownloadRequest, 'format' | 'quality'>): string | undefined {
  if (req.format !== 'mp3' && req.format !== 'm4a' && req.format !== 'opus') return undefined;
  return req.quality === 'best' ? '0' : `${req.quality}K`;
}

/** What yt-dlp can embed in each format. */
export function embedSupport(format: DownloadRequest['format']): { thumbnail: boolean; metadata: boolean; chapters: boolean } {
  switch (format) {
    case 'webm':
      // yt-dlp cannot write cover art into WebM.
      return { thumbnail: false, metadata: true, chapters: true };
    case 'wav':
      return { thumbnail: false, metadata: false, chapters: false };
    default:
      return { thumbnail: true, metadata: true, chapters: true };
  }
}

export interface ArgsPlan {
  /** Shared options from the yt-dlp provider (`commonArgs(cfg, url)`): JS runtime, ffmpeg, cookies, proxy. */
  common: string[];
  /** -o template, inside the job's own directory. */
  outTemplate: string;
  /** The page URL; ignored when `infoJson` is set. */
  url: string;
  /** A `-J` dump to load instead of extracting the page again (`--load-info-json`). */
  infoJson?: string;
  /** Resolved part to keep, in seconds. Leave out for the whole video, or when trimming locally afterwards. */
  section?: { fromSec?: number; toSec?: number };
  /** Abort streams larger than this (yt-dlp --max-filesize). */
  maxFilesizeBytes?: number;
  /** Leave subtitles out (the retry after a subtitle download failed). */
  skipSubtitles?: boolean;
}

/** `*1:00-1:10` style value for --download-sections. */
export function sectionSpec(section: { fromSec?: number; toSec?: number }): string {
  const from = section.fromSec ?? 0;
  const to = section.toSec === undefined ? 'inf' : String(section.toSec);
  return `*${from}-${to}`;
}

export function downloadArgs(req: DownloadRequest, plan: ArgsPlan): string[] {
  const { format, sort } = formatChoice(req);
  const supports = embedSupport(req.format);
  const trimmed = plan.section !== undefined;
  const args = [
    ...plan.common,
    // commonArgs turns progress off for metadata calls; downloads report it. The later flag wins.
    '--progress',
    '--newline',
    '--no-simulate',
    '--no-playlist',
    '--no-warnings',
    '--no-mtime',
    '--windows-filenames',
    '--trim-filenames',
    '160',
    ...PROGRESS_TEMPLATES,
    '-f',
    format,
    '-S',
    sort,
  ];

  if (isVideoContainer(req.format)) {
    // mkv holds anything; mp4 and webm fall back to mkv only if a merge is impossible, then remux back.
    args.push('--merge-output-format', req.format === 'mkv' ? 'mkv' : `${req.format}/mkv`, '--remux-video', req.format);
    if (req.subtitles.length > 0 && !plan.skipSubtitles) {
      args.push('--write-subs', '--write-auto-subs', '--sub-langs', req.subtitles.join(','), '--embed-subs');
    }
  } else {
    args.push('-x', '--audio-format', req.format);
    const q = audioQualityArg(req);
    if (q) args.push('--audio-quality', q);
  }

  if (req.embedMetadata && supports.metadata) args.push('--embed-metadata');
  else args.push('--no-embed-metadata');
  // YouTube serves WebP thumbnails, which yt-dlp would embed as a large PNG; JPEG is small and every player reads it.
  if (req.embedThumbnail && supports.thumbnail) args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  // Chapter times are wrong once the file is cut, so trimmed files get none.
  if (req.embedChapters && supports.chapters && !trimmed && !req.chapter) args.push('--embed-chapters');
  else args.push('--no-embed-chapters');

  if (plan.section) {
    args.push('--download-sections', sectionSpec(plan.section));
    if (req.exactCuts && req.kind === 'video') args.push('--force-keyframes-at-cuts');
  }
  if (req.removeSegments.length > 0) args.push('--sponsorblock-remove', req.removeSegments.join(','));
  if (plan.maxFilesizeBytes && plan.maxFilesizeBytes > 0) args.push('--max-filesize', String(Math.floor(plan.maxFilesizeBytes)));

  args.push('-o', plan.outTemplate);
  if (plan.infoJson) args.push('--load-info-json', plan.infoJson);
  else args.push('--', plan.url);
  return args;
}
