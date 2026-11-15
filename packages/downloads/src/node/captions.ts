/**
 * Captions-only downloads, Node side.
 *
 * Listing: every captions provider that supports the video (`listTracks`),
 * YouTube's machine-translation targets, and yt-dlp's `-J` info as a second
 * source for web URLs.
 *
 * Downloading, per language:
 *   1. the transcript pipeline (`getVideoContext`, mode captions, then stt
 *      when allowed), which covers every source vid2context reads (YouTube
 *      without yt-dlp, podcasts, local files with sidecar or embedded
 *      subtitles, speech-to-text for videos without captions)
 *   2. yt-dlp's subtitle download, which also keeps the site's original file
 *   3. for local files and `original`: the sidecar file as it is, or the
 *      embedded text stream copied out with ffmpeg
 * The result is one file, or a .zip when there are several.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Ctx,
  checkInput,
  getVideoContext,
  type Registry,
  type Transcript,
  Vid2ContextError,
  type VideoContext,
  type VideoRef,
} from '@vid2context/core';
import { locateFfmpeg, probeWith, runProcess, TEXT_SUBTITLE_CODECS, toBcp47 } from '@vid2context/ffmpeg';
import { findSidecars } from '@vid2context/provider-media-file';
import {
  chooseSubtitle,
  commonArgs,
  errorFromStderr,
  fetchInfo,
  parseVtt,
  prepare,
  run,
  toMetadata,
  type YtDlpInfo,
} from '@vid2context/provider-ytdlp';
import { fetchYouTubePlayer, readTranslationLanguages } from '@vid2context/research';
import {
  type CaptionRenderOptions,
  captionFormatList,
  type CaptionsRequest,
  type CaptionTrack,
  type CaptionTracks,
  renderCaptions,
  subtitleMime,
} from '../captions.ts';
import { toolkitLimits } from '../limits.ts';
import { downloadPolicy } from '../policy.ts';
import type { TaskOptions, ToolkitFile } from '../toolkit.ts';
import { outputName } from './files.ts';
import { type Piece, savePieces } from './pack.ts';
import { Watchdog } from './watchdog.ts';

type Resolved = { ref: VideoRef; file?: string; url?: string };

function resolve(input: string, ctx: Ctx, registry: Registry): Resolved {
  const refused = checkInput(input, ctx.env);
  if (refused) throw refused;
  const { ref } = registry.resolve(input);
  if (ref.kind !== 'video') {
    throw new Vid2ContextError('unsupported-input', `"${input.slice(0, 200)}" is a ${ref.kind}, not a single video.`, {
      hint: 'Download captions for a playlist or channel as a batch (POST /downloads/batch with kind captions, or the download_batch tool).',
    });
  }
  if (ref.url?.startsWith('file:')) return { ref, file: fileURLToPath(ref.url) };
  if (ref.url && /^https?:\/\//i.test(ref.url)) return { ref, url: ref.url };
  return { ref };
}

const primary = (code: string) => code.toLowerCase().split(/[-_]/)[0] ?? '';
const sameLanguage = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() || primary(a) === primary(b);

/** Creator tracks and the original automatic tracks in yt-dlp info (YouTube marks those "-orig"). */
function tracksFromInfo(info: YtDlpInfo): { tracks: CaptionTrack[]; targets: { language: string; name: string }[] } {
  const ignored = /^(live_chat|rechat|danmaku|comments)$/i;
  const tracks: CaptionTrack[] = [];
  for (const [key, formats] of Object.entries(info.subtitles ?? {})) {
    if (ignored.test(key)) continue;
    tracks.push({ language: key, name: formats[0]?.name ?? key, auto: false, origin: 'creator-captions', sources: ['ytdlp'] });
  }
  const auto = Object.entries(info.automatic_captions ?? {}).filter(([key]) => !ignored.test(key));
  const originals = auto.filter(([key]) => /-orig$/i.test(key));
  const targets: { language: string; name: string }[] = [];
  if (originals.length > 0) {
    for (const [key, formats] of originals) {
      const language = key.replace(/-orig$/i, '');
      tracks.push({
        language,
        name: formats[0]?.name ?? language,
        auto: true,
        origin: 'auto-captions',
        sources: ['ytdlp'],
        translatable: true,
      });
    }
    for (const [key, formats] of auto) if (!/-orig$/i.test(key)) targets.push({ language: key, name: formats[0]?.name ?? key });
  } else {
    for (const [key, formats] of auto) {
      tracks.push({ language: key, name: formats[0]?.name ?? key, auto: true, origin: 'auto-captions', sources: ['ytdlp'] });
    }
  }
  return { tracks, targets };
}

function merge(into: CaptionTrack[], add: CaptionTrack): void {
  const hit = into.find((t) => t.language.toLowerCase() === add.language.toLowerCase() && t.auto === add.auto);
  if (!hit) {
    into.push({ ...add });
    return;
  }
  for (const s of add.sources) if (!hit.sources.includes(s)) hit.sources.push(s);
  if (add.translatable) hit.translatable = true;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CaptionsEngineDeps {
  registry: Registry;
}

export function createCaptionsEngine({ registry }: CaptionsEngineDeps) {
  async function captionTracks(input: string, ctx: Ctx): Promise<CaptionTracks> {
    const target = resolve(input, ctx, registry);
    const { ref } = target;
    const notes: string[] = [];
    const tracks: CaptionTrack[] = [];
    let title: string | undefined;
    let translationTargets: { language: string; name: string }[] = [];

    for (const p of registry.captions(ctx.env).filter((c) => c.supports(ref) && c.listTracks)) {
      try {
        for (const t of (await p.listTracks?.(ref, ctx)) ?? []) {
          merge(tracks, {
            language: t.language,
            name: t.name,
            auto: t.origin === 'auto-captions',
            origin: t.origin,
            sources: [p.id],
            ...(t.translatable ? { translatable: true } : {}),
          });
        }
      } catch (err) {
        notes.push(`${p.id} could not list tracks: ${message(err)}`);
      }
    }
    if (ref.platform === 'youtube' && tracks.some((t) => t.translatable)) {
      try {
        translationTargets = readTranslationLanguages(await fetchYouTubePlayer(ref.nativeId, ctx));
      } catch (err) {
        notes.push(`YouTube translation targets could not be read: ${message(err)}`);
      }
    }
    // yt-dlp is the second source for web URLs: it reads sites no captions provider covers,
    // and still answers for YouTube when the provider is blocked.
    if (target.url) {
      try {
        const { info } = await fetchInfo(ref, ctx);
        title = info.title ?? undefined;
        const fromInfo = tracksFromInfo(info);
        for (const t of fromInfo.tracks) merge(tracks, t);
        if (translationTargets.length === 0) translationTargets = fromInfo.targets;
      } catch (err) {
        notes.push(`yt-dlp could not read the page: ${message(err)}`);
      }
    }
    if (target.file) title = basename(target.file).replace(/\.[^.]+$/, '');
    const speechToText = registry.sttRungs(ctx.env).length > 0;
    if (tracks.length === 0) {
      notes.push(
        speechToText
          ? 'No caption tracks: a captions download with mode auto or stt transcribes the audio with speech-to-text.'
          : 'No caption tracks, and no speech-to-text rung is configured to transcribe the audio.',
      );
    }
    return {
      input,
      id: ref.id,
      ...(title ? { title } : {}),
      ...(ref.url ? { url: ref.url } : {}),
      tracks,
      translationTargets,
      speechToText,
      formats: captionFormatList(),
      notes,
    };
  }

  /** One language through the pipeline. Null when there is no track in that language. */
  async function viaPipeline(
    req: CaptionsRequest,
    language: string | undefined,
    allowStt: boolean,
    ctx: Ctx,
    opts: TaskOptions,
  ): Promise<VideoContext | null> {
    const base = { ...opts.pipeline, storage: opts.pipeline?.storage ?? null, allowAuto: req.allowAuto };
    const lang = language ? { language } : {};
    const matches = (c: VideoContext) => !language || sameLanguage(c.transcript.language, language);
    let captionsError: unknown;
    if (req.mode !== 'stt') {
      try {
        const c = await getVideoContext(registry, req.input, { ...base, ...lang, mode: 'captions' }, ctx);
        if (matches(c) && (req.allowTranslated || !c.transcript.translated)) return c;
      } catch (err) {
        // No captions, or the captions are blocked (YouTube often answers 429 from servers):
        // speech-to-text on the audio is the next way to a transcript.
        if (!allowStt || ctx.signal?.aborted || !(err instanceof Vid2ContextError)) throw err;
        captionsError = err;
      }
      if (!allowStt) return null;
    }
    try {
      return await getVideoContext(registry, req.input, { ...base, ...lang, mode: 'stt' }, ctx);
    } catch (err) {
      // "No transcript" from speech-to-text says less than why the captions failed.
      if (captionsError && err instanceof Vid2ContextError && err.code === 'no-transcript') throw captionsError;
      throw err;
    }
  }

  /** One language through yt-dlp's subtitle download. Original bytes, or parsed WebVTT for conversions. */
  async function viaYtdlp(
    req: CaptionsRequest,
    target: Resolved,
    language: string | undefined,
    ctx: Ctx,
  ): Promise<{
    piece: Omit<Piece, 'name'> & { ext: string };
    language: string;
    auto: boolean;
    translated: boolean;
    context: VideoContext;
  } | null> {
    if (!target.url) return null;
    const { info, url } = await fetchInfo(target.ref, ctx);
    const choice = chooseSubtitle(info, {
      ...(language ? { language } : {}),
      allowAuto: req.allowAuto,
      allowTranslated: req.allowTranslated,
    });
    if (!choice) return null;
    const { bin, cfg } = await prepare(ctx);
    const dir = await mkdtemp(join(tmpdir(), 'vid2context-subs-'));
    const policy = downloadPolicy(ctx.env);
    const dog = new Watchdog({
      label: 'yt-dlp subtitles',
      stallMs: toolkitLimits(ctx.env).stallSec * 1000,
      deadlineAt: Date.now() + policy.timeoutSec * 1000,
      ...(ctx.signal ? { parent: ctx.signal } : {}),
    });
    try {
      const infoJson = join(dir, 'info.json');
      await writeFile(infoJson, JSON.stringify(info));
      const original = req.format === 'original';
      const args = [
        ...commonArgs(cfg, url),
        '--skip-download',
        '--no-playlist',
        '--no-warnings',
        choice.auto ? '--write-auto-subs' : '--write-subs',
        '--sub-langs',
        choice.key,
        '--sub-format',
        original ? 'best' : 'vtt/srt/best',
        ...(!original && cfg.ffmpeg ? ['--convert-subs', 'vtt'] : []),
        '-o',
        join(dir, 'sub.%(ext)s'),
        '--load-info-json',
        infoJson,
      ];
      const res = await run(
        bin.path,
        args,
        { ...ctx, signal: dog.signal },
        {
          label: 'yt-dlp subtitles',
          timeoutMs: dog.remainingMs(policy.timeoutSec * 1000) + 5000,
          cwd: dir,
          onStdoutLine: () => dog.touch(),
          onStderrLine: () => dog.touch(),
        },
      ).catch((err: unknown) => {
        throw dog.error() ?? err;
      });
      if (res.code !== 0) throw errorFromStderr(res.stderr, 'yt-dlp subtitles', res.code);
      const files = (await readdir(dir)).filter((f) => f.startsWith('sub.') && f !== 'info.json');
      const file = original ? files[0] : (files.find((f) => extname(f) === '.vtt') ?? files.find((f) => extname(f) === '.srt'));
      if (!file) return null;
      const data = new Uint8Array(await readFile(join(dir, file)));
      // "sub.en.vtt": the extension is the last part.
      const ext = extname(file).slice(1).toLowerCase();
      const transcript: Transcript = {
        ref: target.ref,
        language: choice.language,
        origin: choice.auto ? 'auto-captions' : 'creator-captions',
        producer: 'ytdlp-captions',
        ...(choice.translated ? { translated: true } : {}),
        segments: original && ext !== 'vtt' && ext !== 'srt' ? [] : parseVtt(new TextDecoder().decode(data)),
        createdAt: new Date().toISOString(),
      };
      const context: VideoContext = { metadata: toMetadata(target.ref, info), transcript, attempts: [] };
      return {
        piece: { data, mimeType: subtitleMime(ext), ext },
        language: choice.language,
        auto: choice.auto,
        translated: choice.translated,
        context,
      };
    } finally {
      dog.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** `original` for a local file: the sidecar as it is, or the embedded text stream copied out. */
  async function originalFromFile(
    path: string,
    language: string | undefined,
    ctx: Ctx,
  ): Promise<{ data: Uint8Array; ext: string; language: string } | null> {
    const sidecars = findSidecars(path).filter((s) => !s.forced);
    const sidecar = language
      ? sidecars.find((s) => s.language && sameLanguage(s.language, language))
      : (sidecars.find((s) => s.isDefault) ?? sidecars[0]);
    if (sidecar?.path) {
      return {
        data: new Uint8Array(await readFile(sidecar.path)),
        ext: extname(sidecar.path).slice(1).toLowerCase(),
        language: sidecar.language ?? language ?? 'und',
      };
    }
    const tools = await locateFfmpeg(ctx, { download: false });
    const probe = await probeWith(tools.ffprobe, path, ctx);
    const subs = probe.streams.filter((s) => s.type === 'subtitle' && s.codec && TEXT_SUBTITLE_CODECS.has(s.codec));
    const stream = language
      ? subs.find((s) => s.language && sameLanguage(toBcp47(s.language) ?? s.language, language))
      : (subs.find((s) => s.isDefault) ?? subs[0]);
    if (!stream) return null;
    // Copy the text as stored; mov_text (mp4) has no file format of its own, so it becomes SubRip.
    const plan: Record<string, { ext: string; muxer: string; codec: string }> = {
      subrip: { ext: 'srt', muxer: 'srt', codec: 'copy' },
      srt: { ext: 'srt', muxer: 'srt', codec: 'copy' },
      ass: { ext: 'ass', muxer: 'ass', codec: 'copy' },
      ssa: { ext: 'ass', muxer: 'ass', codec: 'copy' },
      webvtt: { ext: 'vtt', muxer: 'webvtt', codec: 'copy' },
    };
    const p = plan[stream.codec ?? ''] ?? { ext: 'srt', muxer: 'srt', codec: 'srt' };
    const res = await runProcess(
      tools.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        path,
        '-map',
        `0:${stream.index}`,
        '-c:s',
        p.codec,
        '-f',
        p.muxer,
        'pipe:1',
      ],
      {
        label: 'ffmpeg subtitle copy',
        captureStdout: true,
        maxStdoutBytes: 32 * 1024 * 1024,
        signal: ctx.signal,
        timeoutMs: 5 * 60_000,
      },
    );
    const lang = stream.language ? (toBcp47(stream.language) ?? stream.language) : (language ?? 'und');
    return { data: res.stdout, ext: p.ext, language: lang };
  }

  /** The second language's transcript for bilingual output: the pipeline (captions only), then yt-dlp. */
  async function secondaryTranscript(
    req: CaptionsRequest,
    target: Resolved,
    language: string,
    ctx: Ctx,
    opts: TaskOptions,
  ): Promise<Transcript> {
    const order = req.via === 'pipeline' ? ['pipeline'] : req.via === 'ytdlp' ? ['ytdlp'] : ['pipeline', 'ytdlp'];
    const asCaptions: CaptionsRequest = { ...req, mode: 'captions', format: 'vtt' };
    let firstError: unknown;
    for (const path of order) {
      try {
        if (path === 'pipeline') {
          const c = await viaPipeline(asCaptions, language, false, ctx, opts);
          if (c) return c.transcript;
        } else {
          const got = await viaYtdlp(asCaptions, target, language, ctx);
          if (got && got.context.transcript.segments.length > 0) return got.context.transcript;
        }
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
    throw new Vid2ContextError('no-transcript', `No ${language} captions for ${target.ref.id}.`, {
      hint: 'Pick a language from the track list or its translation targets.',
    });
  }

  /** The languages to write: as asked, every listed track, or the default (undefined). */
  async function languagesFor(req: CaptionsRequest, ctx: Ctx, warnings: string[]): Promise<(string | undefined)[]> {
    const max = toolkitLimits(ctx.env).maxCaptionTracks;
    if (!req.allLanguages) return req.languages.length > 0 ? req.languages : [undefined];
    const list = await captionTracks(req.input, ctx);
    const wanted: string[] = [...req.languages];
    // Creator tracks first; an automatic track only for a language the creator did not cover.
    for (const t of [...list.tracks].sort((a, b) => Number(a.auto) - Number(b.auto))) {
      if (t.auto && !req.allowAuto) continue;
      if (!wanted.some((w) => w.toLowerCase() === t.language.toLowerCase())) wanted.push(t.language);
    }
    if (wanted.length === 0) {
      for (const n of list.notes) warnings.push(n);
      return [undefined];
    }
    if (wanted.length > max) {
      warnings.push(`This video has ${wanted.length} tracks; the first ${max} were saved (VID2CONTEXT_MAX_CAPTION_TRACKS).`);
      return wanted.slice(0, max);
    }
    return wanted;
  }

  async function captions(req: CaptionsRequest, ctx: Ctx, opts: TaskOptions): Promise<ToolkitFile> {
    const target = resolve(req.input, ctx, registry);
    const warnings: string[] = [];
    const report = opts.onProgress;
    report?.({ phase: 'preparing', downloadedBytes: 0 });
    const languages = await languagesFor(req, ctx, warnings);
    // Speech-to-text for a missing track only makes sense for the spoken language: one asked (or none).
    const allowStt = req.mode !== 'captions' && languages.length === 1;
    const pieces: Piece[] = [];
    const tracks: NonNullable<ToolkitFile['tracks']> = [];
    const failures: { language: string; error: unknown }[] = [];
    let title = target.file ? basename(target.file).replace(/\.[^.]+$/, '') : undefined;
    const id = target.file ? undefined : target.ref.nativeId;

    // Bilingual output: the second language is fetched once, by the same paths as the primary (no speech-to-text:
    // it is meant to be another language than the spoken one).
    let second: Transcript | undefined;
    if (req.secondary) {
      report?.({ phase: 'downloading', downloadedBytes: 0, percent: 0, step: `Captions ${req.secondary} (second language)` });
      second = await secondaryTranscript(req, target, req.secondary, ctx, opts).catch((err: unknown) => {
        if (ctx.signal?.aborted) throw err;
        warnings.push(`The second language (${req.secondary}) could not be fetched, so the files have one language: ${message(err)}`);
        return undefined;
      });
    }
    const render: CaptionRenderOptions = {
      timestamps: req.timestamps,
      ...(req.offsetSec !== undefined ? { offsetSec: req.offsetSec } : {}),
      ...(req.maxLineChars !== undefined ? { maxLineChars: req.maxLineChars } : {}),
      ...(req.maxLines !== undefined ? { maxLines: req.maxLines } : {}),
      ...(second ? { secondary: second } : {}),
    };
    const pairSuffix = second ? `+${second.language}` : '';

    for (const [i, language] of languages.entries()) {
      report?.({
        phase: 'downloading',
        downloadedBytes: 0,
        percent: Math.round((i / languages.length) * 1000) / 10,
        step: `Captions ${language ?? 'default'}`,
      });
      const order: ('pipeline' | 'ytdlp' | 'file')[] =
        req.via === 'pipeline'
          ? ['pipeline']
          : req.via === 'ytdlp'
            ? ['ytdlp']
            : req.format === 'original'
              ? target.file
                ? ['file', 'pipeline']
                : ['ytdlp', 'pipeline']
              : ['pipeline', 'ytdlp'];
      const errors: unknown[] = [];
      let done = false;
      for (const path of order) {
        try {
          if (path === 'file' && target.file) {
            const got = await originalFromFile(target.file, language, ctx);
            if (!got) continue;
            pieces.push({
              name: outputName({ title: title ?? 'captions', ext: `${got.language}.${got.ext}` }),
              data: got.data,
              mimeType: subtitleMime(got.ext),
            });
            tracks.push({ language: got.language, origin: 'creator-captions', producer: 'media-file', via: 'file' });
            done = true;
          } else if (path === 'ytdlp') {
            const got = await viaYtdlp(req, target, language, ctx);
            if (!got) continue;
            title ??= got.context.metadata.title;
            if (req.format === 'original') {
              pieces.push({
                name: outputName({ title, ...(id ? { id } : {}), ext: `${got.language}.${got.piece.ext}` }),
                data: got.piece.data,
                mimeType: got.piece.mimeType,
              });
            } else {
              if (got.context.transcript.segments.length === 0) continue;
              const r = renderCaptions(got.context, req.format, render);
              pieces.push({
                name: outputName({ title, ...(id ? { id } : {}), ext: `${got.language}${pairSuffix}.${r.ext}` }),
                data: new TextEncoder().encode(r.text),
                mimeType: r.mimeType,
              });
            }
            tracks.push({
              language: got.language,
              origin: got.auto ? 'auto-captions' : 'creator-captions',
              producer: 'ytdlp-captions',
              via: 'ytdlp',
              ...(got.translated ? { translated: true } : {}),
              ...(second && req.format !== 'original' ? { secondary: second.language } : {}),
            });
            done = true;
          } else if (path === 'pipeline') {
            const c = await viaPipeline(req, language, allowStt, ctx, opts);
            if (!c) continue;
            title ??= c.metadata.title;
            const format = req.format === 'original' ? 'vtt' : req.format;
            if (req.format === 'original') {
              warnings.push(
                `No original file for ${c.transcript.language}; saved WebVTT made from the ${c.transcript.origin} transcript instead.`,
              );
            }
            const r = renderCaptions(c, format, render);
            pieces.push({
              name: outputName({ title, ...(id ? { id } : {}), ext: `${c.transcript.language}${pairSuffix}.${r.ext}` }),
              data: new TextEncoder().encode(r.text),
              mimeType: r.mimeType,
            });
            tracks.push({
              language: c.transcript.language,
              origin: c.transcript.origin,
              producer: c.transcript.producer,
              via: 'pipeline',
              ...(c.transcript.translated ? { translated: true } : {}),
              ...(second ? { secondary: second.language } : {}),
            });
            done = true;
          }
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          errors.push(err);
          ctx.log.info('captions: path failed', { path, language, error: message(err) });
        }
        if (done) break;
      }
      if (done && errors.length > 0) {
        warnings.push(`${language ?? 'Default language'}: the first path failed (${message(errors[0])}), the next one worked.`);
      }
      if (!done) failures.push({ language: language ?? 'default', error: errors[0] });
    }

    if (pieces.length === 0) {
      const first = failures[0]?.error;
      if (first instanceof Vid2ContextError) throw first;
      throw new Vid2ContextError(
        'no-transcript',
        `No captions in ${languages.map((l) => l ?? 'the default language').join(', ')} for ${target.ref.id}.${first ? ` ${message(first)}` : ''}`,
        {
          hint:
            req.mode === 'captions'
              ? 'List the tracks first (captionTracks, GET /downloads/captions/tracks), or use mode auto to transcribe the audio.'
              : 'List the tracks first; for other languages, check translationTargets.',
        },
      );
    }
    for (const f of failures)
      warnings.push(`${f.language}: not saved (${f.error ? message(f.error) : 'no track in that language'}).`);
    const saved = await savePieces(pieces, {
      dir: opts.dir,
      ...(opts.overwrite !== undefined ? { overwrite: opts.overwrite } : {}),
      zipName: outputName({ title: `${title ?? 'captions'} captions`, ...(id ? { id } : {}), ext: 'zip' }),
      forceZip: req.zip,
    });
    report?.({ phase: 'finished', percent: 100, downloadedBytes: saved.bytes, totalBytes: saved.bytes });
    return {
      ...saved,
      kind: 'captions',
      title: title ?? target.ref.id,
      source: target.url ?? target.file ?? req.input,
      tracks,
      warnings,
    };
  }

  return { captionTracks, captions };
}
