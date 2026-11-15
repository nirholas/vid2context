/**
 * `vid2context download`: save videos as mp4, webm or mkv, or their audio as
 * mp3, m4a, opus, flac or wav. stdout gets one saved path per line (or JSON
 * with --json), so `vid2context download <url> --audio | xargs ...` works;
 * progress, warnings and failures go to stderr.
 */
import { isAbsolute, resolve } from 'node:path';
import { expandInput, limits, Vid2ContextError } from '@vid2context/core';
import {
  clock,
  type DownloadedFile,
  type DownloadProgress,
  downloadPolicy,
  mb,
  normalizeAnimationRequest,
  normalizeBatchRequest,
  normalizeFramesRequest,
  normalizeRequest,
  normalizeThumbnailRequest,
  optionsSummary,
  type RawDownloadRequest,
  type Toolkit,
  type ToolkitFile,
  toolkitOf,
} from '@vid2context/downloads';
import { createDownloader } from '@vid2context/downloads/node';
import { bool, positiveInt, str } from '../args.ts';
import { exitCodeFor, UsageError } from '../exit-codes.ts';
import type { CommandContext } from '../runtime.ts';
import { notePlaylist } from './video.ts';

/** SponsorBlock categories `--sponsorblock` cuts when given without a list. */
export const DEFAULT_SPONSOR_CUT = 'sponsor,selfpromo,interaction';

function progressLabel(p: DownloadProgress, prefix: string): string {
  if (p.phase === 'preparing' || p.phase === 'queued') return `${prefix}: preparing`;
  if (p.phase === 'processing')
    return `${prefix}: ${p.step ?? 'processing'}${p.percent !== undefined && p.percent < 100 ? ` ${p.percent}%` : ''}`;
  if (p.phase === 'finished') return `${prefix}: done`;
  const parts = [`${prefix}: ${p.percent !== undefined ? `${p.percent.toFixed(1)}%` : mb(p.downloadedBytes)}`];
  if (p.totalBytes) parts.push(`of ${mb(p.totalBytes)}`);
  if (p.speedBps) parts.push(`${mb(p.speedBps)}/s`);
  if (p.etaSec !== undefined) parts.push(`ETA ${clock(p.etaSec)}`);
  return parts.join(', ');
}

/** The request fields from the flags; the input is filled in per video. */
export function requestFromFlags(c: CommandContext): Omit<RawDownloadRequest, 'input'> {
  const video = str(c.values, 'video');
  const audio = str(c.values, 'audio');
  if (video !== undefined && audio !== undefined) {
    throw new UsageError('Pass --video or --audio, not both.', 'Run the command twice to get both.');
  }
  const kind = audio !== undefined ? 'audio' : 'video';
  const format = audio !== undefined ? audio || 'mp3' : video || 'mp4';
  const sponsor = str(c.values, 'sponsorblock');
  return {
    kind,
    format,
    quality: str(c.values, 'quality'),
    from: str(c.values, 'from'),
    to: str(c.values, 'to'),
    chapter: str(c.values, 'chapter'),
    exactCuts: bool(c.values, 'exact-cuts'),
    embedThumbnail: !bool(c.values, 'no-thumbnail'),
    embedMetadata: !bool(c.values, 'no-metadata'),
    embedChapters: !bool(c.values, 'no-chapters'),
    subtitles: str(c.values, 'subs'),
    removeSegments: sponsor === undefined ? undefined : sponsor || DEFAULT_SPONSOR_CUT,
    burnSubtitles: str(c.values, 'burn-subs'),
    ...(bool(c.values, 'split-chapters') ? { splitChapters: true } : {}),
  };
}

/** Which kind of output the flags ask for: the media file (default), a thumbnail, frames, or an animated clip. */
function outputMode(c: CommandContext): 'media' | 'thumbnail' | 'frames' | 'animation' {
  const picked = [
    str(c.values, 'thumbnail') !== undefined ? 'thumbnail' : undefined,
    str(c.values, 'frames') !== undefined ? 'frames' : undefined,
    bool(c.values, 'gif') || bool(c.values, 'webp') ? 'animation' : undefined,
  ].filter((m): m is 'thumbnail' | 'frames' | 'animation' => m !== undefined);
  if (picked.length > 1 || (bool(c.values, 'gif') && bool(c.values, 'webp'))) {
    throw new UsageError('Pass one of --thumbnail, --frames, --gif or --webp.', 'Run the command once per output.');
  }
  return picked[0] ?? 'media';
}

function savedNote(c: CommandContext, f: ToolkitFile): void {
  if (!c.json) c.out.text(`${f.path}\n`);
  const inside = f.entries?.length ? `, ${f.entries.length} files` : '';
  c.note(`saved ${f.filename} (${mb(f.bytes)}${f.durationSec ? `, ${clock(f.durationSec)}` : ''}${inside})`);
  for (const w of f.warnings) c.note(`note: ${w}`);
}

export async function downloadCommand(c: CommandContext): Promise<number> {
  if (c.positionals.length === 0) {
    throw new UsageError('Pass a video URL, YouTube id or file path to download.', 'Run `vid2context download --help`.');
  }
  const ctx = c.deps.ctx;
  const policy = downloadPolicy(ctx.env);
  if (!policy.enabled)
    throw new Vid2ContextError('unavailable', policy.reason ?? 'Downloads are off.', { hint: 'Unset VID2CONTEXT_DOWNLOADS=0.' });
  const fields = requestFromFlags(c);
  const mode = outputMode(c);
  // Validate the flags once before any network call, so a typo fails fast.
  if (mode === 'media') normalizeRequest({ ...fields, input: c.positionals[0] });
  const frameFields = {
    times: str(c.values, 'frames'),
    format: str(c.values, 'frame-format'),
    width: str(c.values, 'width'),
    quality: str(c.values, 'quality'),
    zip: bool(c.values, 'zip'),
  };
  const clipFields = {
    from: str(c.values, 'from'),
    to: str(c.values, 'to'),
    fps: str(c.values, 'fps'),
    width: str(c.values, 'width'),
    format: bool(c.values, 'webp') ? 'webp' : 'gif',
  };
  if (mode === 'frames') normalizeFramesRequest({ ...frameFields, input: c.positionals[0] }, ctx.env);
  if (mode === 'animation') normalizeAnimationRequest({ ...clipFields, input: c.positionals[0] }, ctx.env);
  const downloader = createDownloader({ registry: c.deps.registry });
  const toolkit = toolkitOf(downloader) as Toolkit;

  if (bool(c.values, 'info')) {
    const all = [];
    for (const input of c.positionals) {
      c.progress.start(`Reading ${input}`);
      try {
        all.push(await downloader.probe(input, ctx));
      } finally {
        c.progress.stop();
      }
    }
    c.out.text(
      c.json ? `${JSON.stringify(all.length === 1 ? all[0] : all, null, 2)}\n` : `${all.map(optionsSummary).join('\n\n')}\n`,
    );
    return 0;
  }

  const dirFlag = str(c.values, 'dir');
  const dir = dirFlag
    ? dirFlag.startsWith('~')
      ? downloader.outputDir(ctx, dirFlag)
      : isAbsolute(dirFlag)
        ? dirFlag
        : resolve(c.cwd, dirFlag)
    : ctx.env.VID2CONTEXT_DOWNLOAD_DIR?.trim()
      ? downloader.outputDir(ctx)
      : c.cwd;

  if (mode !== 'media') {
    const outputs: unknown[] = [];
    let firstError: unknown;
    for (const input of c.positionals) {
      c.progress.start(`${input}: preparing`);
      try {
        if (mode === 'thumbnail') {
          if (!downloader.thumbnail)
            throw new Vid2ContextError('no-provider', 'This downloader cannot save thumbnails.', { hint: 'Update vid2context.' });
          const saved = await downloader.thumbnail(
            normalizeThumbnailRequest({ url: input, format: str(c.values, 'thumbnail') || undefined }),
            ctx,
            {
              dir,
              overwrite: bool(c.values, 'force'),
            },
          );
          c.progress.stop();
          outputs.push(saved);
          if (!c.json) c.out.text(`${saved.path}\n`);
          c.note(
            `saved ${saved.filename} (${mb(saved.bytes)}${saved.width && saved.height ? `, ${saved.width}x${saved.height}` : ''})`,
          );
        } else {
          const opts = {
            dir,
            overwrite: bool(c.values, 'force'),
            onProgress: (p: DownloadProgress) => c.progress.start(progressLabel(p, input)),
          };
          const file =
            mode === 'frames'
              ? await toolkit.frames(normalizeFramesRequest({ ...frameFields, input }, ctx.env), ctx, opts)
              : await toolkit.animation(normalizeAnimationRequest({ ...clipFields, input }, ctx.env), ctx, opts);
          c.progress.stop();
          outputs.push(file);
          savedNote(c, file);
        }
      } catch (err) {
        c.progress.stop();
        if (ctx.signal?.aborted || c.positionals.length === 1) throw err;
        firstError ??= err;
        c.deps.io.stderr(`failed ${input}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (c.json) c.out.text(`${JSON.stringify({ dir, files: outputs }, null, 2)}\n`);
    return firstError ? exitCodeFor(firstError) : 0;
  }

  if (bool(c.values, 'zip')) {
    // One .zip of everything: a batch through the toolkit, with one status per video.
    const req = normalizeBatchRequest(
      {
        ...fields,
        urls: c.positionals,
        zip: true,
        playlist: bool(c.values, 'playlist'),
        ...(positiveInt(c.values, 'limit') ? { limit: positiveInt(c.values, 'limit') } : {}),
      },
      ctx.env,
    );
    try {
      const result = await toolkit.batch(req, ctx, {
        dir,
        overwrite: bool(c.values, 'force'),
        onProgress: (p) => c.progress.start(progressLabel(p, 'batch')),
      });
      c.progress.stop();
      const items = result.items ?? [];
      if (c.json) c.out.text(`${JSON.stringify({ dir, file: result.file, items }, null, 2)}\n`);
      else if (result.file) savedNote(c, result.file);
      for (const i of items) {
        if (i.status === 'error')
          c.deps.io.stderr(`failed ${i.input}: ${i.error?.message}\n${i.error?.hint ? `  hint: ${i.error.hint}\n` : ''}`);
      }
      const failed = items.find((i) => i.status === 'error');
      return failed
        ? exitCodeFor(
            new Vid2ContextError((failed.error?.code ?? 'upstream') as Vid2ContextError['code'], failed.error?.message ?? ''),
          )
        : 0;
    } finally {
      c.progress.stop();
    }
  }

  // Playlists, channels and feeds become their videos.
  const limit = positiveInt(c.values, 'limit') ?? limits(ctx.env).maxPlaylistItems;
  const inputs: string[] = [];
  const playlist = bool(c.values, 'playlist');
  for (const input of c.positionals) {
    const resolved = c.deps.registry.resolve(input);
    if (resolved.ref.kind === 'video' && !(playlist && resolved.list)) {
      inputs.push(input);
      if (resolved.list) notePlaylist(c, input, 'download');
      continue;
    }
    c.progress.start(`Listing ${input}`);
    try {
      const refs = await expandInput(c.deps.registry, input, ctx, { limit, list: playlist });
      inputs.push(...refs.map((r) => r.url ?? r.id));
      c.progress.stop();
      c.note(`${input}: ${refs.length} video${refs.length === 1 ? '' : 's'}`);
    } finally {
      c.progress.stop();
    }
  }

  const saved: DownloadedFile[] = [];
  const failed: { input: string; error: unknown }[] = [];
  for (const [i, input] of inputs.entries()) {
    const prefix = inputs.length > 1 ? `[${i + 1}/${inputs.length}] ${input}` : input;
    c.progress.start(`${prefix}: preparing`);
    try {
      const file = await downloader.download(normalizeRequest({ ...fields, input }), ctx, {
        dir,
        overwrite: bool(c.values, 'force'),
        onProgress: (p) => c.progress.start(progressLabel(p, prefix)),
      });
      c.progress.stop();
      saved.push(file);
      if (!c.json) c.out.text(`${file.path}\n`);
      c.note(`saved ${file.filename} (${mb(file.bytes)}${file.durationSec ? `, ${clock(file.durationSec)}` : ''})`);
      for (const part of file.parts ?? []) {
        if (!c.json) c.out.text(`${part.path}\n`);
        c.note(`  chapter ${part.index}: ${part.filename} (${clock(part.fromSec)}-${clock(part.toSec)})`);
      }
      for (const w of file.warnings) c.note(`note: ${w}`);
    } catch (err) {
      c.progress.stop();
      if (ctx.signal?.aborted || inputs.length === 1) throw err;
      failed.push({ input, error: err });
      const e = err instanceof Vid2ContextError ? err : undefined;
      c.deps.io.stderr(
        `failed ${input}: ${err instanceof Error ? err.message : String(err)}\n${e?.hint ? `  hint: ${e.hint}\n` : ''}`,
      );
    }
  }
  if (c.json) {
    c.out.text(
      `${JSON.stringify(
        {
          dir,
          files: saved,
          failed: failed.map((f) => ({ input: f.input, error: f.error instanceof Error ? f.error.message : String(f.error) })),
        },
        null,
        2,
      )}\n`,
    );
  }
  if (saved.length > 0 && !c.quiet && inputs.length > 1) c.note(`${saved.length} of ${inputs.length} saved to ${dir}`);
  if (failed.length > 0) return exitCodeFor(failed[0]?.error);
  return 0;
}
