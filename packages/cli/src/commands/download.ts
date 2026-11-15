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
  normalizeRequest,
  optionsSummary,
  type RawDownloadRequest,
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
  };
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
  // Validate the flags once before any network call, so a typo fails fast.
  normalizeRequest({ ...fields, input: c.positionals[0] });
  const downloader = createDownloader({ registry: c.deps.registry });

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
