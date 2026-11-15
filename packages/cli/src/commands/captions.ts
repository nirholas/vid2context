/**
 * `vid2context captions`: save captions or subtitles only, as srt (default),
 * vtt, txt, json, markdown or the site's original file. One video gives one
 * file (or a .zip for several languages); several inputs, playlists and
 * channels run as a batch with one line per item. stdout gets the saved
 * paths (JSON with --json); progress and notes go to stderr.
 *
 * `--list` shows the tracks instead: creator and automatic, language names,
 * and the languages the platform can machine-translate into.
 */
import { isAbsolute, resolve } from 'node:path';
import { Vid2ContextError } from '@vid2context/core';
import {
  type CaptionTracks,
  downloadPolicy,
  mb,
  normalizeBatchRequest,
  normalizeCaptionsRequest,
  type RawCaptionsRequest,
  type TaskOptions,
  type Toolkit,
  toolkitOf,
} from '@vid2context/downloads';
import { createDownloader } from '@vid2context/downloads/node';
import { bool, list, positiveInt, str } from '../args.ts';
import { exitCodeFor, UsageError } from '../exit-codes.ts';
import type { CommandContext } from '../runtime.ts';

export function tracksText(t: CaptionTracks): string {
  const lines: string[] = [];
  if (t.title) lines.push(t.title);
  if (t.tracks.length === 0) lines.push('No caption tracks.');
  for (const x of t.tracks) {
    lines.push(
      `${x.language.padEnd(8)} ${x.auto ? 'auto   ' : 'creator'}  ${x.name}${x.translatable ? '  (translatable)' : ''}  [${x.sources.join(', ')}]`,
    );
  }
  if (t.translationTargets.length > 0) {
    lines.push(`Machine translation into: ${t.translationTargets.map((x) => x.language).join(', ')}`);
  }
  lines.push(`Speech-to-text fallback: ${t.speechToText ? 'available' : 'not configured'}`);
  for (const n of t.notes) lines.push(`note: ${n}`);
  return `${lines.join('\n')}\n`;
}

/** The captions request fields from the flags; the input is filled in per video. */
export function captionsFieldsFromFlags(c: CommandContext): Omit<RawCaptionsRequest, 'input' | 'url'> {
  const langs = list(c.values, 'lang');
  return {
    ...(langs ? { languages: langs } : {}),
    format: str(c.values, 'format'),
    mode: str(c.values, 'mode'),
    via: str(c.values, 'via'),
    allowAuto: !bool(c.values, 'no-auto'),
    allowTranslated: !bool(c.values, 'no-translate'),
    timestamps: bool(c.values, 'timestamps'),
    zip: bool(c.values, 'zip'),
  };
}

/** --dir as the download command reads it: relative to the working directory, default VID2CONTEXT_DOWNLOAD_DIR or cwd. */
export function saveDir(c: CommandContext, outputDir: (dir?: string) => string): string {
  const dirFlag = str(c.values, 'dir');
  if (dirFlag) return dirFlag.startsWith('~') ? outputDir(dirFlag) : isAbsolute(dirFlag) ? dirFlag : resolve(c.cwd, dirFlag);
  return c.deps.ctx.env.VID2CONTEXT_DOWNLOAD_DIR?.trim() ? outputDir() : c.cwd;
}

export function progressNote(c: CommandContext, prefix: string): TaskOptions['onProgress'] {
  return (p) => {
    const what = p.phase === 'processing' || p.phase === 'downloading' ? (p.step ?? p.phase) : p.phase;
    c.progress.start(`${prefix}: ${what}${p.percent !== undefined && p.phase !== 'finished' ? ` ${p.percent}%` : ''}`);
  };
}

export async function captionsCommand(c: CommandContext): Promise<number> {
  if (c.positionals.length === 0) {
    throw new UsageError('Pass a video URL, YouTube id or file path.', 'Run `vid2context captions --help`.');
  }
  const ctx = c.deps.ctx;
  const policy = downloadPolicy(ctx.env);
  if (!policy.enabled)
    throw new Vid2ContextError('unavailable', policy.reason ?? 'Downloads are off.', { hint: 'Unset VID2CONTEXT_DOWNLOADS=0.' });
  const downloader = createDownloader({ registry: c.deps.registry });
  const toolkit = toolkitOf(downloader) as Toolkit;
  const fields = captionsFieldsFromFlags(c);
  // Validate the flags before any network call.
  normalizeCaptionsRequest({ ...fields, input: c.positionals[0] }, ctx.env);

  if (bool(c.values, 'list')) {
    const all: CaptionTracks[] = [];
    for (const input of c.positionals) {
      c.progress.start(`Reading ${input}`);
      try {
        all.push(await toolkit.captionTracks(input, ctx));
      } finally {
        c.progress.stop();
      }
    }
    c.out.text(c.json ? `${JSON.stringify(all.length === 1 ? all[0] : all, null, 2)}\n` : all.map(tracksText).join('\n'));
    return 0;
  }

  const dir = saveDir(c, (d) => downloader.outputDir(ctx, d));
  const pipeline = c.getOptions();
  const single = c.positionals.length === 1 && c.deps.registry.resolve(c.positionals[0] as string).ref.kind === 'video';
  if (single && !(bool(c.values, 'playlist') && c.deps.registry.resolve(c.positionals[0] as string).list)) {
    const input = c.positionals[0] as string;
    c.progress.start(`${input}: preparing`);
    try {
      const file = await toolkit.captions(normalizeCaptionsRequest({ ...fields, input }, ctx.env), ctx, {
        dir,
        overwrite: bool(c.values, 'force'),
        pipeline: { chain: pipeline.chain, ...(pipeline.stt ? { stt: pipeline.stt } : {}) },
        onProgress: progressNote(c, input),
      });
      c.progress.stop();
      c.out.text(c.json ? `${JSON.stringify({ dir, file }, null, 2)}\n` : `${file.path}\n`);
      const via = file.tracks?.map((t) => `${t.language} (${t.origin}, ${t.via})`).join(', ');
      c.note(`saved ${file.filename} (${mb(file.bytes)})${via ? `: ${via}` : ''}`);
      for (const w of file.warnings) c.note(`note: ${w}`);
      return 0;
    } finally {
      c.progress.stop();
    }
  }

  // Several inputs, playlists or channels: one batch, one status per video.
  const req = normalizeBatchRequest(
    {
      ...fields,
      urls: c.positionals,
      kind: 'captions',
      zip: bool(c.values, 'zip'),
      playlist: bool(c.values, 'playlist'),
      ...(positiveInt(c.values, 'limit') ? { limit: positiveInt(c.values, 'limit') } : {}),
    },
    ctx.env,
  );
  let lastLine = '';
  try {
    const result = await toolkit.batch(req, ctx, {
      dir,
      overwrite: bool(c.values, 'force'),
      pipeline: { chain: pipeline.chain, ...(pipeline.stt ? { stt: pipeline.stt } : {}) },
      onProgress: progressNote(c, 'captions'),
      onItems: (items) => {
        const running = items.find((i) => i.status === 'running');
        const line = running ? `[${running.index + 1}/${items.length}] ${running.input}` : '';
        if (line && line !== lastLine) {
          lastLine = line;
          c.progress.start(line);
        }
      },
    });
    c.progress.stop();
    const items = result.items ?? [];
    if (c.json) c.out.text(`${JSON.stringify({ dir, ...(result.file ? { file: result.file } : {}), items }, null, 2)}\n`);
    else if (result.file) c.out.text(`${result.file.path}\n`);
    else for (const i of items) if (i.status === 'done' && i.file) c.out.text(`${resolve(dir, i.file.filename)}\n`);
    for (const i of items) {
      if (i.status === 'error')
        c.deps.io.stderr(`failed ${i.input}: ${i.error?.message}\n${i.error?.hint ? `  hint: ${i.error.hint}\n` : ''}`);
    }
    for (const w of [...(result.warnings ?? []), ...(result.file?.warnings ?? [])]) c.note(`note: ${w}`);
    const done = items.filter((i) => i.status === 'done').length;
    c.note(`${done} of ${items.length} saved to ${dir}`);
    const failed = items.find((i) => i.status === 'error');
    if (failed)
      return exitCodeFor(
        new Vid2ContextError((failed.error?.code ?? 'upstream') as Vid2ContextError['code'], failed.error?.message ?? ''),
      );
    return 0;
  } finally {
    c.progress.stop();
  }
}
