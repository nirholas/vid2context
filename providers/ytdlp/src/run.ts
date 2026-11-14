/**
 * Running yt-dlp for a provider call: resolve the binary, build the shared
 * config, apply timeouts, map failures to errors, and retry Vimeo pages that
 * demand a login through the embed player URL. Info JSON is cached per ctx,
 * so metadata, captions and audio for one request share a single -J call.
 */
import { type Ctx, type Env, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { configFrom, metadataArgs, type RunConfig } from './args.ts';
import { type YtDlpInfo as BinaryInfo, ensureYtDlp } from './binary.ts';
import { errorFromStderr } from './errors.ts';
import type { YtDlpInfo } from './info.ts';
import { run } from './process.ts';
import { vimeoPlayerUrl } from './refs.ts';

export type Step = 'metadata' | 'playlist' | 'comments' | 'captions' | 'audio';

const DEFAULT_TIMEOUT_SEC: Record<Step, number> = { metadata: 60, playlist: 120, comments: 300, captions: 120, audio: 300 };

/** YTDLP_TIMEOUT_SEC applies to every step when set; otherwise each step has its own default. */
export function timeoutMs(env: Env, step: Step): number {
  const n = Number(env.YTDLP_TIMEOUT_SEC);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC[step]) * 1000;
}

export interface Prepared {
  bin: BinaryInfo;
  cfg: RunConfig;
}

export async function prepare(ctx: Ctx): Promise<Prepared> {
  const bin = await ensureYtDlp(ctx);
  return { bin, cfg: configFrom(ctx.env, bin.jsRuntime, bin.ffmpeg) };
}

/** Run yt-dlp; a non-zero exit becomes a mapped Vid2ContextError. Returns stdout. */
export async function ytdlp(ctx: Ctx, bin: string, args: string[], step: Step, cwd?: string): Promise<string> {
  const label = `yt-dlp ${step}`;
  const res = await run(bin, args, ctx, { timeoutMs: timeoutMs(ctx.env, step), label, cwd });
  if (res.code !== 0) throw errorFromStderr(res.stderr, label, res.code);
  return res.stdout;
}

/** The URL yt-dlp should fetch for a ref. */
export function urlOf(ref: VideoRef): string {
  const url = ref.url ?? ref.input;
  if (!/^https?:\/\//i.test(url)) {
    throw new Vid2ContextError('unsupported-input', `${ref.id} has no http(s) URL for yt-dlp.`, {
      hint: 'yt-dlp works on web URLs; local files go through the media-file provider.',
    });
  }
  return url;
}

function wantsLogin(err: unknown): boolean {
  return err instanceof Vid2ContextError && err.code === 'auth' && /logged-in|log in|login/i.test(err.message);
}

/**
 * Run `fn` on the ref's URL. When a vimeo.com page answers that it needs a
 * login and no cookies are configured, retry once on the player URL.
 */
export async function withFallbackUrl<T>(ctx: Ctx, url: string, fn: (url: string) => Promise<T>): Promise<T> {
  try {
    return await fn(url);
  } catch (err) {
    const alt = vimeoPlayerUrl(url);
    if (!alt || !wantsLogin(err) || ctx.env.YTDLP_COOKIES_FILE || ctx.env.YTDLP_COOKIES_FROM_BROWSER) throw err;
    ctx.log.info('yt-dlp: vimeo.com wants a login; retrying through the player URL', { url: alt });
    return await fn(alt);
  }
}

export interface InfoResult {
  info: YtDlpInfo;
  /** The URL that worked (the player URL after a Vimeo fallback). */
  url: string;
}

const infoCache = new WeakMap<Ctx, Map<string, Promise<InfoResult>>>();

/** `yt-dlp -J` for a video ref, cached per ctx. */
export function fetchInfo(ref: VideoRef, ctx: Ctx): Promise<InfoResult> {
  const url = urlOf(ref);
  let cache = infoCache.get(ctx);
  if (!cache) {
    cache = new Map();
    infoCache.set(ctx, cache);
  }
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      const { bin, cfg } = await prepare(ctx);
      return withFallbackUrl(ctx, url, async (u) => {
        const stdout = await ytdlp(ctx, bin.path, metadataArgs(u, cfg), 'metadata');
        return { info: parseJson(stdout, 'yt-dlp metadata'), url: u };
      });
    })();
    const entry = p;
    cache.set(url, entry);
    entry.catch(() => {
      if (cache?.get(url) === entry) cache.delete(url);
    });
  }
  return p;
}

/** The working URL for a ref when this ctx already fetched its info, else its own URL. */
export async function workingUrl(ref: VideoRef, ctx: Ctx): Promise<string> {
  const url = urlOf(ref);
  const cached = infoCache.get(ctx)?.get(url);
  if (!cached) return url;
  try {
    return (await cached).url;
  } catch {
    return url;
  }
}

export function parseJson(stdout: string, label: string): YtDlpInfo {
  const text = stdout.trim();
  // -J prints one JSON document; take the last line that parses, in case an extractor printed something first.
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.startsWith('{')) continue;
    try {
      return JSON.parse(line) as YtDlpInfo;
    } catch {
      break;
    }
  }
  try {
    return JSON.parse(text) as YtDlpInfo;
  } catch {
    throw new Vid2ContextError('upstream', `${label}: yt-dlp did not print JSON.`, {
      hint: 'Update yt-dlp (delete .vid2context/bin/yt-dlp.json to force an update check) and retry.',
    });
  }
}
