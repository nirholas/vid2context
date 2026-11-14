/**
 * yt-dlp argument builders. Pure functions, so tests can assert the exact
 * argv. Every command ends with `--` and the URL, and URLs are checked first:
 * only http(s), never anything starting with "-", so an input can never be
 * read as an option.
 */
import { type Env, Vid2ContextError } from '@vid2context/core';
import type { JsRuntime } from './binary.ts';

export interface RunConfig {
  jsRuntime: JsRuntime;
  ffmpeg?: string;
  cookiesFile?: string;
  cookiesFromBrowser?: string;
  /** First entry of YOUTUBE_PROXY: passed as --proxy for YouTube URLs only (yt-dlp takes one proxy). */
  youtubeProxy?: string;
}

/** The first http(s) entry of YOUTUBE_PROXY, the same proxy the Node fetch uses for YouTube. */
function firstProxy(raw: string | undefined): string | undefined {
  const first = raw
    ?.split(',')
    .map((s) => s.trim())
    .find(Boolean);
  return first && /^https?:\/\//i.test(first) ? first : undefined;
}

const YOUTUBE_URL = /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be|youtube-nocookie\.com)(?=[/:?#]|$)/i;

/** True for youtube.com, youtu.be and youtube-nocookie.com URLs (any subdomain). */
export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_URL.test(url.trim());
}

export function configFrom(env: Env, jsRuntime: JsRuntime, ffmpeg?: string): RunConfig {
  return {
    jsRuntime,
    ...(ffmpeg ? { ffmpeg } : {}),
    ...(env.YTDLP_COOKIES_FILE ? { cookiesFile: env.YTDLP_COOKIES_FILE } : {}),
    ...(env.YTDLP_COOKIES_FROM_BROWSER ? { cookiesFromBrowser: env.YTDLP_COOKIES_FROM_BROWSER } : {}),
    ...(firstProxy(env.YOUTUBE_PROXY) ? { youtubeProxy: firstProxy(env.YOUTUBE_PROXY) } : {}),
  };
}

/** Reject anything that is not a plain http(s) URL. */
export function safeUrl(input: string): string {
  const url = input.trim();
  if (url.startsWith('-')) {
    throw new Vid2ContextError('bad-request', 'URLs passed to yt-dlp must not start with "-".', {
      hint: 'Pass an http(s) URL.',
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Vid2ContextError('bad-request', `Not a URL: ${url.slice(0, 200)}`, { hint: 'Pass an http(s) URL.' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Vid2ContextError('bad-request', `yt-dlp only takes http(s) URLs, not ${parsed.protocol}`, {
      hint: 'Pass an http(s) URL; local files are handled by the media-file provider.',
    });
  }
  return url;
}

/**
 * Options shared by every command: no config files, no colour, the JS runtime,
 * cookies and ffmpeg, and --proxy when `url` is a YouTube URL and
 * YOUTUBE_PROXY is set (other sites are fetched directly).
 */
export function commonArgs(cfg: RunConfig, url?: string): string[] {
  const args = ['--ignore-config', '--no-color', '--no-progress'];
  // deno is yt-dlp's default runtime; Node must be named (with its path when it is not on PATH).
  if (cfg.jsRuntime.name === 'node') args.push('--js-runtimes', `node:${cfg.jsRuntime.path}`);
  if (cfg.ffmpeg) args.push('--ffmpeg-location', cfg.ffmpeg);
  if (cfg.cookiesFile) args.push('--cookies', cfg.cookiesFile);
  if (cfg.cookiesFromBrowser) args.push('--cookies-from-browser', cfg.cookiesFromBrowser);
  if (cfg.youtubeProxy && url && isYouTubeUrl(url)) args.push('--proxy', cfg.youtubeProxy);
  return args;
}

export function metadataArgs(url: string, cfg: RunConfig): string[] {
  return [...commonArgs(cfg, url), '-J', '--no-download', '--no-playlist', '--no-warnings', '--', safeUrl(url)];
}

export function playlistArgs(url: string, cfg: RunConfig, limit?: number): string[] {
  const args = [...commonArgs(cfg, url), '--flat-playlist', '-J', '--no-warnings'];
  if (limit && limit > 0) args.push('--playlist-end', String(Math.floor(limit)));
  return [...args, '--', safeUrl(url)];
}

/**
 * Comments ride on the -J dump. `max_comments` is YouTube's limit
 * (total, parents, replies, replies per thread); other extractors that
 * support comments ignore it and the result is cut to `limit` afterwards.
 */
export function commentsArgs(url: string, cfg: RunConfig, limit: number): string[] {
  const n = Math.max(1, Math.floor(limit));
  return [
    ...commonArgs(cfg, url),
    '-J',
    '--no-download',
    '--no-playlist',
    '--no-warnings',
    '--write-comments',
    '--extractor-args',
    `youtube:max_comments=${n},${n},${n},${Math.min(n, 10)};comment_sort=top`,
    '--',
    safeUrl(url),
  ];
}

/** Download one subtitle track (creator or automatic) into `outTemplate`, without the media. */
export function subtitleArgs(
  url: string,
  cfg: RunConfig,
  opts: { language: string; auto: boolean; outTemplate: string },
): string[] {
  const args = [
    ...commonArgs(cfg, url),
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    opts.auto ? '--write-auto-subs' : '--write-subs',
    '--sub-langs',
    opts.language,
    '--sub-format',
    'vtt/srt/best',
  ];
  // With ffmpeg, other text formats (ass, ttml) are converted to WebVTT, which the parser reads.
  if (cfg.ffmpeg) args.push('--convert-subs', 'vtt');
  return [...args, '-o', opts.outTemplate, '--', safeUrl(url)];
}

/** Best audio, extracted to 16 kHz mono 32 kbps mp3 (about 14 MB per hour). Prints the duration when done. */
export function audioArgs(url: string, cfg: RunConfig, outTemplate: string): string[] {
  return [
    ...commonArgs(cfg, url),
    '--no-playlist',
    '--no-warnings',
    '-f',
    'bestaudio/best',
    '-x',
    '--audio-format',
    'mp3',
    '--postprocessor-args',
    'ffmpeg:-ac 1 -ar 16000 -b:a 32k',
    '-o',
    outTemplate,
    '--print',
    'after_move:%(duration)s',
    '--',
    safeUrl(url),
  ];
}
