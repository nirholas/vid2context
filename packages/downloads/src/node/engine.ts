/**
 * The Node downloader. Web URLs go through yt-dlp (the provider's managed,
 * checksum-verified binary); local files go through ffmpeg.
 *
 * One yt-dlp download:
 *   1. `-J` info (cached per ctx, so the probe the web app made is reused)
 *   2. checks: not live, not a playlist, within the duration limit; a chapter
 *      becomes a start and end time
 *   3. yt-dlp downloads from the saved info (`--load-info-json`), printing
 *      progress lines that ProgressTracker folds into one percentage
 *   4. recoveries: a fresh run on HTTP 403 (expired stream URLs), a run
 *      without subtitles when a subtitle track fails (YouTube often answers
 *      429), and a full download plus a local trim when ffmpeg crashes on the
 *      section download
 *   5. the file is renamed from the title and moved into the target directory
 */
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Ctx, checkInput, type Registry, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type FfmpegTools, locateFfmpeg, tryLocateFfmpeg } from '@vid2context/ffmpeg';
import {
  commonArgs,
  ensureYtDlp,
  errorFromStderr,
  fetchInfo,
  matchUrl,
  prepare,
  run,
  withFallbackUrl,
} from '@vid2context/provider-ytdlp';
import { downloadArgs } from '../args.ts';
import { estimateBytes } from '../estimate.ts';
import { type MediaInfo, type MediaOptions, mediaOptions } from '../formats.ts';
import { toolkitLimits } from '../limits.ts';
import { clock, type DownloadRequest, findChapter, isTrimmed, MIME_TYPES } from '../options.ts';
import { downloadPolicy } from '../policy.ts';
import { type DownloadProgress, ProgressTracker, parseLine } from '../progress.ts';
import type { DownloadedFile, Downloader, DownloaderStatus, DownloadOptions } from '../types.ts';
import { preflightDisk } from './disk.ts';
import { moveInto, outputName } from './files.ts';
import { convertPlan, hasVideo, probeFile, runFfmpeg, trimArgs } from './local.ts';
import { Watchdog } from './watchdog.ts';

export interface DownloaderOptions {
  /** Resolves YouTube ids and other inputs to URLs or local files. Without one, inputs must be http(s) URLs or paths. */
  registry?: Registry;
}

type Target = { type: 'url'; url: string; ref: VideoRef } | { type: 'file'; path: string };

function resolveTarget(input: string, ctx: Ctx, registry?: Registry): Target {
  const refused = checkInput(input, ctx.env);
  if (refused) throw refused;
  let ref: VideoRef | null = null;
  if (registry) ref = registry.resolve(input).ref;
  else if (/^https?:\/\//i.test(input.trim())) ref = matchUrl(input);
  if (ref) {
    if (ref.kind !== 'video') {
      throw new Vid2ContextError('unsupported-input', `"${input.slice(0, 200)}" is a ${ref.kind}, not a single video.`, {
        hint: 'Download its videos one by one: the CLI and the download_media tool take a playlist with a limit, and the web app lists its items.',
      });
    }
    if (ref.platform === 'file' && ref.url?.startsWith('file:')) return { type: 'file', path: fileURLToPath(ref.url) };
    const url = ref.url ?? input;
    if (/^https?:\/\//i.test(url)) return { type: 'url', url, ref };
    if (url.startsWith('upload:')) {
      throw new Vid2ContextError('unsupported-input', 'Uploaded files cannot be downloaded again.', {
        hint: 'You already have the file; convert it locally with `vid2context download <path> --audio mp3`.',
      });
    }
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return { type: 'file', path: isAbsolute(input) ? input : resolvePath(input) };
  throw new Vid2ContextError('unsupported-input', `Cannot download "${input.slice(0, 200)}".`, {
    hint: 'Pass an http(s) video URL, a YouTube id, or a local media file path.',
  });
}

function infoOf(raw: unknown): MediaInfo {
  return raw as MediaInfo;
}

/** The part of the video to keep, from from/to or a chapter, checked against the duration. */
export function resolveSection(
  req: DownloadRequest,
  info: Pick<MediaInfo, 'duration' | 'chapters'>,
): { fromSec: number; toSec?: number; chapter?: string } | undefined {
  if (!isTrimmed(req)) return undefined;
  const duration = typeof info.duration === 'number' && info.duration > 0 ? info.duration : undefined;
  if (req.chapter !== undefined) {
    const chapters = (info.chapters ?? [])
      .filter((c) => typeof c.start_time === 'number')
      .map((c, i) => ({ title: c.title?.trim() || `Chapter ${i + 1}`, start: c.start_time as number, end: c.end_time }));
    if (chapters.length === 0) {
      throw new Vid2ContextError('bad-request', 'This video has no chapters.', { hint: 'Use from and to instead.' });
    }
    const hit = findChapter(chapters, req.chapter);
    if (!hit) {
      throw new Vid2ContextError('bad-request', `No chapter matches "${req.chapter.slice(0, 80)}".`, {
        hint: `Chapters: ${chapters
          .map((c, i) => `${i} ${c.title}`)
          .join('; ')
          .slice(0, 400)}`,
      });
    }
    const end = hit.chapter.end ?? chapters[hit.index + 1]?.start ?? duration;
    return { fromSec: hit.chapter.start, ...(end !== undefined ? { toSec: end } : {}), chapter: hit.chapter.title };
  }
  const fromSec = req.fromSec ?? 0;
  if (duration !== undefined && fromSec >= duration) {
    throw new Vid2ContextError('bad-request', `from (${clock(fromSec)}) is past the end of the video (${clock(duration)}).`, {
      hint: 'Pick a start inside the video.',
    });
  }
  const toSec = req.toSec !== undefined && (duration === undefined || req.toSec < duration) ? req.toSec : undefined;
  return { fromSec, ...(toSec !== undefined ? { toSec } : {}) };
}

function checkLimits(ctx: Ctx, info: MediaInfo, section: { fromSec: number; toSec?: number } | undefined): void {
  const policy = downloadPolicy(ctx.env);
  const duration = typeof info.duration === 'number' ? info.duration : undefined;
  const kept = section ? (section.toSec ?? duration ?? 0) - section.fromSec : duration;
  if (policy.maxDurationSec > 0 && kept !== undefined && kept > policy.maxDurationSec) {
    throw new Vid2ContextError(
      'too-large',
      `The video is ${clock(kept)} long; this server downloads at most ${clock(policy.maxDurationSec)}.`,
      { hint: 'Download a part with from and to, or raise VID2CONTEXT_MAX_DOWNLOAD_MIN.' },
    );
  }
}

const isFfmpegCrash = (msg: string) =>
  /ffmpeg exited with code -?(11|139)\b|SIGSEGV|Segmentation fault|ffmpeg exited with code -?\d+/i.test(msg);
const isSubtitleFailure = (msg: string) => /subtitle/i.test(msg);
const is403 = (msg: string) => /HTTP Error 403/i.test(msg);

const MEDIA_EXTS = new Set(['mp4', 'webm', 'mkv', 'mp3', 'm4a', 'opus', 'flac', 'wav', 'ogg', 'mov']);

async function findOutput(dir: string, printed: string[], format: string): Promise<string | undefined> {
  for (const p of [...printed].reverse()) {
    try {
      if ((await stat(p)).isFile()) return p;
    } catch {
      // yt-dlp printed a path it later moved; fall through to the listing.
    }
  }
  const files = (await readdir(dir)).filter((f) => MEDIA_EXTS.has(extname(f).slice(1).toLowerCase()) && !f.endsWith('.part'));
  const exact = files.find((f) => extname(f).slice(1).toLowerCase() === format);
  const pick = exact ?? files[0];
  return pick ? join(dir, pick) : undefined;
}

function expandHome(dir: string): string {
  return dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\') ? join(homedir(), dir.slice(1)) : dir;
}

export function outputDir(ctx: Ctx, dir?: string): string {
  const configured = ctx.env.VID2CONTEXT_DOWNLOAD_DIR?.trim();
  const base = configured ? resolvePath(expandHome(configured)) : join(homedir(), 'Downloads', 'vid2context');
  const wanted = dir?.trim();
  if (!wanted) return base;
  const expanded = expandHome(wanted);
  return isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(base, expanded);
}

export function createDownloader(options: DownloaderOptions = {}): Downloader {
  const { registry } = options;

  async function ytdlpInfo(target: Extract<Target, { type: 'url' }>, ctx: Ctx): Promise<MediaInfo> {
    const { info } = await fetchInfo(target.ref, ctx).catch((err: unknown) => {
      // A private video is a fact about the video, as the YouTube provider (and so /context) reports it: not-found, not unavailable.
      if (err instanceof Vid2ContextError && err.code === 'unavailable' && /private video/i.test(err.message)) {
        throw new Vid2ContextError('not-found', err.message, { ...(err.hint ? { hint: err.hint } : {}), cause: err });
      }
      throw err;
    });
    const media = infoOf(info);
    if (media._type === 'playlist') {
      throw new Vid2ContextError('unsupported-input', 'This URL is a playlist, not a single video.', {
        hint: 'Download its videos one by one, or pass a playlist with a limit to the CLI or download_media.',
      });
    }
    return media;
  }

  async function downloadUrl(
    req: DownloadRequest,
    target: Extract<Target, { type: 'url' }>,
    ctx: Ctx,
    opts: DownloadOptions,
  ): Promise<DownloadedFile> {
    const report = (p: DownloadProgress) => opts.onProgress?.(p);
    report({ phase: 'preparing', downloadedBytes: 0 });
    const info = await ytdlpInfo(target, ctx);
    if (info.is_live === true || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
      throw new Vid2ContextError(
        'unsupported-input',
        'This is a live or upcoming stream; it can be downloaded once it has ended.',
        {
          hint: 'Wait for the stream to finish, or use watch_live to transcribe it while it runs.',
        },
      );
    }
    const section = resolveSection(req, info);
    checkLimits(ctx, info, section);
    const policy = downloadPolicy(ctx.env);
    const tk = toolkitLimits(ctx.env);
    // One budget for the whole download: retries and the local trim share it instead of each getting the full timeout.
    const deadlineAt = Date.now() + policy.timeoutSec * 1000;
    const estimate = estimateBytes(req, mediaOptions(info), section);
    if (estimate !== undefined && policy.maxBytes > 0 && estimate > policy.maxBytes * 1.25) {
      throw new Vid2ContextError(
        'too-large',
        `This download would be about ${Math.round(estimate / 1048576)} MB; the limit is ${Math.round(policy.maxBytes / 1048576)} MB.`,
        { hint: 'Pick a lower quality or a shorter part, or raise VID2CONTEXT_MAX_DOWNLOAD_MB.' },
      );
    }
    const { bin, cfg } = await prepare(ctx);
    if (!cfg.ffmpeg) {
      throw new Vid2ContextError(
        'no-provider',
        'Downloads need ffmpeg to merge video and audio and to convert audio, and none was found.',
        {
          hint: 'Install ffmpeg (apt install ffmpeg, brew install ffmpeg, winget install ffmpeg) or set FFMPEG_PATH.',
        },
      );
    }

    const work = await mkdtemp(join(tmpdir(), 'vid2context-dl-'));
    const warnings: string[] = [];
    try {
      if (estimate !== undefined) {
        // A video is downloaded as two streams and merged into a third file, so the temp folder holds it about twice.
        await preflightDisk(
          [
            { dir: work, bytes: estimate * (req.kind === 'video' ? 2 : 1.5), label: 'the temp folder' },
            { dir: opts.dir, bytes: estimate, label: 'the download folder' },
          ],
          tk.minFreeMb,
        );
      }
      const infoJson = join(work, 'info.json');
      await writeFile(infoJson, JSON.stringify(info));
      let useInfo = true;
      let useSection = section !== undefined;
      let skipSubtitles = false;
      let tracker = new ProgressTracker();
      let stalls = 0;
      for (let attempt = 0; ; attempt++) {
        tracker = new ProgressTracker();
        const t = tracker;
        const attemptDir = join(work, `a${attempt}`);
        const dog = new Watchdog({
          label: 'yt-dlp download',
          stallMs: tk.stallSec * 1000,
          deadlineAt,
          ...(policy.maxBytes > 0 ? { maxBytes: Math.round(policy.maxBytes * 1.1) } : {}),
          dir: attemptDir,
          ...(ctx.signal ? { parent: ctx.signal } : {}),
          // yt-dlp prints nothing while its ffmpeg post-processes (ExtractAudio on a long video takes minutes):
          // the output file growing is the progress, measured against the estimated size.
          onPoll: (bytes) => {
            if (estimate !== undefined && t.processing(bytes - t.progress.downloadedBytes, estimate)) report(t.progress);
          },
        });
        const runCtx: Ctx = { ...ctx, signal: dog.signal };
        const onLine = (line: string) => {
          // Any output, progress or not, means the process is alive and working.
          dog.touch();
          const event = parseLine(line);
          if (event && t.apply(event)) {
            if (event.type === 'download') dog.reportBytes(t.progress.downloadedBytes);
            report(t.progress);
          }
        };
        const url = target.url;
        const args = downloadArgs(req, {
          common: commonArgs(cfg, url),
          outTemplate: join(attemptDir, 'media.%(ext)s'),
          url,
          ...(useInfo ? { infoJson } : {}),
          ...(useSection && section ? { section } : {}),
          ...(policy.maxBytes > 0 ? { maxFilesizeBytes: policy.maxBytes } : {}),
          skipSubtitles,
        });
        try {
          await withFallbackUrl(runCtx, url, async (u) => {
            const finalArgs = useInfo ? args : [...args.slice(0, -1), u];
            // The watchdog's deadline fires first, with the right setting in its hint; this timer is a backstop.
            const res = await run(bin.path, finalArgs, runCtx, {
              label: 'yt-dlp download',
              timeoutMs: dog.remainingMs(policy.timeoutSec * 1000) + 5000,
              ownQueue: true,
              discardStdout: true,
              onStdoutLine: onLine,
              onStderrLine: onLine,
              maxStderr: 256 * 1024,
            });
            if (res.code !== 0) throw errorFromStderr(res.stderr, 'yt-dlp download', res.code);
          });
        } catch (err) {
          dog.stop();
          const stopped = dog.error();
          if (dog.tripped === 'stall' && stalls < tk.stallRetries) {
            stalls++;
            warnings.push(
              `yt-dlp stopped making progress for ${tk.stallSec} s, so it was restarted (${stalls} of ${tk.stallRetries}).`,
            );
            ctx.log.info('downloads: stalled; restarting yt-dlp', { url, stalls });
            continue;
          }
          if (stopped) throw stopped;
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt >= 4 || !(err instanceof Vid2ContextError)) throw err;
          if (is403(msg) && useInfo) {
            ctx.log.info('downloads: stream URL answered 403; extracting the page again', { url });
            useInfo = false;
            continue;
          }
          if (req.subtitles.length > 0 && !skipSubtitles && isSubtitleFailure(msg)) {
            warnings.push(`Subtitles (${req.subtitles.join(', ')}) could not be downloaded, so the file has none: ${msg}`);
            skipSubtitles = true;
            continue;
          }
          if (useSection && isFfmpegCrash(msg)) {
            warnings.push(
              'ffmpeg could not download just the requested part (some static ffmpeg builds crash on https URLs), so the whole video was downloaded and trimmed locally.',
            );
            useSection = false;
            continue;
          }
          throw err;
        }
        dog.stop();
        break;
      }

      const attemptDirs = (await readdir(work))
        .filter((d) => /^a\d+$/.test(d))
        .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
      const lastDir = join(work, attemptDirs[0] ?? 'a0');
      let file = await findOutput(lastDir, tracker.files, req.format);
      if (!file) {
        throw new Vid2ContextError('upstream', 'yt-dlp finished but wrote no file.', {
          hint:
            policy.maxBytes > 0
              ? `The file may be larger than this server's limit (${Math.round(policy.maxBytes / 1048576)} MB, VID2CONTEXT_MAX_DOWNLOAD_MB).`
              : 'Check that ffmpeg works (ffmpeg -version) and retry.',
        });
      }

      if (section && !useSection) {
        const tools = await locateFfmpeg(ctx, { download: true });
        const source = await probeFile(tools, file, ctx);
        const trimmed = join(work, `trimmed.${req.format}`);
        const downloaded = tracker.progress.downloadedBytes;
        report({ phase: 'processing', step: 'Trim', downloadedBytes: downloaded, percent: 0 });
        await runFfmpeg({
          tools,
          input: file,
          output: trimmed,
          args: trimArgs(req, source),
          format: req.format,
          section,
          ctx,
          timeoutMs: Math.max(1000, deadlineAt - Date.now()),
          watchdog: { stallMs: tk.stallSec * 1000, deadlineAt, maxBytes: policy.maxBytes },
          accurate: req.kind === 'audio' || req.exactCuts,
          ...(section.toSec !== undefined ? { durationSec: section.toSec - section.fromSec } : {}),
          onPercent: (percent) => report({ phase: 'processing', step: 'Trim', downloadedBytes: downloaded, percent }),
        });
        file = trimmed;
      }

      const ext = extname(file).slice(1).toLowerCase() || req.format;
      if (ext !== req.format) warnings.push(`The file was saved as .${ext}; .${req.format} could not hold these streams.`);
      const title = info.title || info.fulltitle || 'video';
      const name = outputName({ title, ...(info.id ? { id: info.id } : {}), ext, ...(section ? { section } : {}) });
      const finalPath = await moveInto(file, opts.dir, name, opts.overwrite);
      const bytes = (await stat(finalPath)).size;
      if (policy.maxBytes > 0 && bytes > policy.maxBytes) {
        await rm(finalPath, { force: true });
        throw new Vid2ContextError(
          'too-large',
          `The file is ${Math.round(bytes / 1048576)} MB; the limit is ${Math.round(policy.maxBytes / 1048576)} MB.`,
          {
            hint: 'Pick a lower quality or a shorter part, or raise VID2CONTEXT_MAX_DOWNLOAD_MB.',
          },
        );
      }
      report(tracker.finish(bytes));
      const duration = typeof info.duration === 'number' ? info.duration : undefined;
      const keptDuration = section ? (section.toSec ?? duration ?? 0) - section.fromSec : duration;
      return {
        path: finalPath,
        filename: finalPath.slice(opts.dir.replace(/[/\\]+$/, '').length + 1),
        bytes,
        mimeType: MIME_TYPES[req.format] && ext === req.format ? MIME_TYPES[req.format] : 'application/octet-stream',
        kind: req.kind,
        format: req.format,
        title,
        source: info.webpage_url ?? target.url,
        ...(keptDuration !== undefined && keptDuration > 0 ? { durationSec: keptDuration } : {}),
        ...(section ? { section } : {}),
        warnings,
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async function convertFile(req: DownloadRequest, path: string, ctx: Ctx, opts: DownloadOptions): Promise<DownloadedFile> {
    const report = (p: DownloadProgress) => opts.onProgress?.(p);
    report({ phase: 'preparing', downloadedBytes: 0 });
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(path);
    } catch {
      throw new Vid2ContextError('not-found', `No such file: ${path}`, { hint: 'Check the path, or pass a video URL.' });
    }
    if (!st.isFile()) throw new Vid2ContextError('bad-request', `${path} is not a file.`, { hint: 'Pass a media file.' });
    const tools = await locateFfmpeg(ctx, { download: true });
    const source = await probeFile(tools, path, ctx);
    if (req.kind === 'video' && !hasVideo(source)) {
      throw new Vid2ContextError('unsupported-input', `${path} has no video track.`, { hint: 'Download it as audio instead.' });
    }
    if (!source.streams.some((s) => s.type === 'audio') && req.kind === 'audio') {
      throw new Vid2ContextError('unsupported-input', `${path} has no audio track.`, { hint: 'Pick a file with sound.' });
    }
    const info: MediaInfo = {
      duration: source.durationSec ?? null,
      chapters: source.chapters.map((c) => ({
        title: c.title,
        start_time: c.startSec,
        ...(c.endSec !== undefined ? { end_time: c.endSec } : {}),
      })),
    };
    const section = resolveSection(req, info);
    const policy = downloadPolicy(ctx.env);
    const tk = toolkitLimits(ctx.env);
    const deadlineAt = Date.now() + policy.timeoutSec * 1000;
    const plan = convertPlan(req, source, { trimmed: section !== undefined });
    const work = await mkdtemp(join(tmpdir(), 'vid2context-dl-'));
    try {
      const out = join(work, `out.${req.format}`);
      const duration = section ? (section.toSec ?? source.durationSec ?? 0) - section.fromSec : source.durationSec;
      report({ phase: 'processing', step: plan.reencodes ? 'Convert' : 'Remux', downloadedBytes: 0, percent: 0 });
      await runFfmpeg({
        tools,
        input: path,
        output: out,
        args: plan.args,
        format: req.format,
        ...(section ? { section } : {}),
        ...(duration ? { durationSec: duration } : {}),
        ctx,
        timeoutMs: policy.timeoutSec * 1000,
        watchdog: { stallMs: tk.stallSec * 1000, deadlineAt, maxBytes: policy.maxBytes },
        // Audio, and exact video cuts, start at `from` even where streams are copied.
        accurate: req.kind === 'audio' || req.exactCuts,
        onPercent: (percent) =>
          report({ phase: 'processing', step: plan.reencodes ? 'Convert' : 'Remux', downloadedBytes: 0, percent }),
      });
      const base = path.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '');
      const title = source.tags.title?.trim() || base;
      const name = outputName({ title: base, ext: req.format, ...(section ? { section } : {}) });
      const finalPath = await moveInto(out, opts.dir, name, opts.overwrite);
      const bytes = (await stat(finalPath)).size;
      report({ phase: 'finished', percent: 100, downloadedBytes: bytes, totalBytes: bytes });
      return {
        path: finalPath,
        filename: finalPath.slice(opts.dir.replace(/[/\\]+$/, '').length + 1),
        bytes,
        mimeType: MIME_TYPES[req.format],
        kind: req.kind,
        format: req.format,
        title,
        source: path,
        ...(duration ? { durationSec: duration } : {}),
        ...(section ? { section } : {}),
        warnings:
          req.removeSegments.length > 0
            ? ['SponsorBlock segments apply to YouTube videos only; nothing was cut from the local file.']
            : [],
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  return {
    outputDir,

    async probe(input, ctx) {
      const target = resolveTarget(input, ctx, registry);
      if (target.type === 'file') {
        const tools = await locateFfmpeg(ctx, { download: true });
        const p = await probeFile(tools, target.path, ctx);
        const audio = p.streams.find((s) => s.type === 'audio');
        const video = p.streams.find((s) => s.type === 'video' && !s.isAttachedPic);
        return mediaOptions({
          title: p.tags.title?.trim() || target.path.replace(/^.*[/\\]/, ''),
          duration: p.durationSec ?? null,
          chapters: p.chapters.map((c) => ({
            title: c.title,
            start_time: c.startSec,
            ...(c.endSec !== undefined ? { end_time: c.endSec } : {}),
          })),
          formats: [
            ...(video
              ? [
                  {
                    format_id: 'video',
                    vcodec: video.codec ?? 'unknown',
                    acodec: 'none',
                    width: video.width ?? null,
                    height: video.height ?? null,
                  },
                ]
              : []),
            ...(audio
              ? [
                  {
                    format_id: 'audio',
                    vcodec: 'none',
                    acodec: audio.codec ?? 'unknown',
                    asr: audio.sampleRate ?? null,
                    audio_channels: audio.channels ?? null,
                  },
                ]
              : []),
          ],
        }) satisfies MediaOptions;
      }
      return mediaOptions(await ytdlpInfo(target, ctx));
    },

    async download(req, ctx, opts) {
      const target = resolveTarget(req.input, ctx, registry);
      return target.type === 'file' ? convertFile(req, target.path, ctx, opts) : downloadUrl(req, target, ctx, opts);
    },

    async status(ctx): Promise<DownloaderStatus> {
      const out: DownloaderStatus = { ready: false };
      try {
        const bin = await ensureYtDlp(ctx);
        out.ytdlp = { version: bin.version, path: bin.path };
        const ffmpeg = bin.ffmpeg ?? (await tryLocateFfmpeg(ctx).then((t: FfmpegTools | null) => t?.ffmpeg));
        if (ffmpeg) out.ffmpeg = { path: ffmpeg };
        out.ready = !!ffmpeg;
        if (!ffmpeg)
          out.problem = 'ffmpeg was not found. Install it (apt install ffmpeg, brew install ffmpeg) or set FFMPEG_PATH.';
      } catch (err) {
        const e = err as { message?: string; hint?: string };
        out.problem = `${e.message ?? String(err)}${e.hint ? ` ${e.hint}` : ''}`;
      }
      return out;
    },
  };
}
