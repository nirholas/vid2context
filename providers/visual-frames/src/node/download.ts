/**
 * Download a low-resolution, video-only copy of a URL with yt-dlp (Node only),
 * for frame sampling. The binary comes from prompt 11's provider
 * (`ensureYtDlp`: YTDLP_PATH, then PATH, then its managed, checksum-verified
 * copy). No shell; the URL is validated and passed after `--`.
 */
import { join } from 'node:path';
import { type Ctx, Vid2ContextError } from '@vid2context/core';
import { runProcess } from '@vid2context/ffmpeg';
import { ensureYtDlp, errorFromStderr, safeUrl } from '@vid2context/provider-ytdlp';

/** 480p or lower is plenty for reading slides and keeps downloads small; fall back to the smallest stream. */
export const VIDEO_FORMAT = 'bv*[height<=480]/b[height<=480]/wv*/w';

const DEFAULT_TIMEOUT_SEC = 30 * 60;

type YtDlp = Awaited<ReturnType<typeof ensureYtDlp>>;

/**
 * The flags prompt 11's yt-dlp provider puts on every run (its `commonArgs`,
 * which the package does not export): ignore user config, name Node as the JS
 * runtime when deno is absent, and point at ffmpeg and cookies when set.
 */
export function commonArgs(bin: Pick<YtDlp, 'jsRuntime' | 'ffmpeg'>, env: Record<string, string | undefined>): string[] {
  const args = ['--ignore-config', '--no-color', '--no-progress'];
  if (bin.jsRuntime.name === 'node') args.push('--js-runtimes', `node:${bin.jsRuntime.path}`);
  if (bin.ffmpeg) args.push('--ffmpeg-location', bin.ffmpeg);
  if (env.YTDLP_COOKIES_FILE) args.push('--cookies', env.YTDLP_COOKIES_FILE);
  if (env.YTDLP_COOKIES_FROM_BROWSER) args.push('--cookies-from-browser', env.YTDLP_COOKIES_FROM_BROWSER);
  return args;
}

export function downloadArgs(url: string, outDir: string, common: string[]): string[] {
  return [
    ...common,
    '--no-playlist',
    '--no-warnings',
    '-f',
    VIDEO_FORMAT,
    '-o',
    join(outDir, 'video.%(ext)s'),
    '--print',
    'after_move:filepath',
    '--',
    safeUrl(url),
  ];
}

/** Download `url` into `outDir` and return the file path. */
export async function downloadVideo(url: string, outDir: string, ctx: Ctx): Promise<string> {
  let bin: YtDlp;
  try {
    bin = await ensureYtDlp(ctx);
  } catch (err) {
    throw new Vid2ContextError('no-provider', `yt-dlp is needed to read frames from a URL: ${err instanceof Error ? err.message : String(err)}`, {
      hint: 'Install yt-dlp with `npx tsx providers/ytdlp/src/setup.ts` (@vid2context/provider-ytdlp) or set YTDLP_PATH, or pass a local video file instead.',
      cause: err,
    });
  }
  const n = Number(ctx.env.YTDLP_TIMEOUT_SEC);
  const timeoutMs = (Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC) * 1000;
  const stderr: string[] = [];
  const label = 'yt-dlp video download';
  let stdout: Uint8Array;
  try {
    ({ stdout } = await runProcess(bin.path, downloadArgs(url, outDir, commonArgs(bin, ctx.env)), {
      label,
      signal: ctx.signal,
      timeoutMs,
      captureStdout: true,
      maxStdoutBytes: 1024 * 1024,
      stderrTailBytes: 64 * 1024,
      onStderrLine: (line) => {
        stderr.push(line);
        if (stderr.length > 400) stderr.shift();
      },
    }));
  } catch (err) {
    if (err instanceof Vid2ContextError && err.code === 'timeout') {
      throw new Vid2ContextError('timeout', err.message, { hint: 'Raise YTDLP_TIMEOUT_SEC for long videos or slow networks.' });
    }
    if (!(err instanceof Vid2ContextError)) throw err;
    throw errorFromStderr(stderr.join('\n'), label);
  }
  const path = new TextDecoder()
    .decode(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!path) {
    throw new Vid2ContextError('upstream', `${label}: yt-dlp finished but printed no file path.`, {
      hint: 'Update yt-dlp, or download the video yourself and pass the local file.',
    });
  }
  return path;
}
