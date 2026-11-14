/**
 * Subtitle extraction: text subtitle streams (subrip, mov_text, webvtt, ass
 * and the other text codecs ffmpeg decodes) become WebVTT text. Bitmap
 * subtitles (DVD, Blu-ray PGS) carry images, not text, and are refused.
 */
import { Vid2ContextError } from '@vid2context/core';
import { locateFfmpeg } from './locate.ts';
import { type ProbeStream, probeWith } from './probe.ts';
import { type FfCtx, inputGuards, isUrlInput, runProcess, toInput } from './process.ts';

/** Subtitle codecs that carry text ffmpeg can convert to WebVTT. */
export const TEXT_SUBTITLE_CODECS: ReadonlySet<string> = new Set([
  'subrip',
  'srt',
  'mov_text',
  'webvtt',
  'ass',
  'ssa',
  'text',
  'microdvd',
  'subviewer',
  'subviewer1',
  'sami',
  'realtext',
  'stl',
  'jacosub',
  'mpl2',
  'pjs',
  'vplayer',
]);

/** Text subtitle streams of a probe result, default streams first. */
export function textSubtitleStreams(streams: ProbeStream[]): ProbeStream[] {
  return streams
    .filter((s) => s.type === 'subtitle' && s.codec !== undefined && TEXT_SUBTITLE_CODECS.has(s.codec))
    .sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false));
}

/**
 * Extract one subtitle stream as WebVTT. Without `streamIndex`, the first text
 * subtitle stream (default disposition first) is used.
 */
export async function extractSubtitles(
  input: string,
  streamIndex?: number,
  ctx: FfCtx = {},
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const target = toInput(input);
  const tools = await locateFfmpeg(ctx, { download: false });
  const info = await probeWith(tools.ffprobe, target, ctx);
  const subs = info.streams.filter((s) => s.type === 'subtitle');
  let stream: ProbeStream | undefined;
  if (streamIndex === undefined) {
    stream = textSubtitleStreams(info.streams)[0];
    if (!stream) {
      throw new Vid2ContextError(
        'unavailable',
        subs.length ? 'The media has only image-based subtitles, which carry no text.' : 'The media has no subtitle streams.',
        { hint: 'Use a sidecar .srt or .vtt file, or transcribe the audio instead.' },
      );
    }
  } else {
    stream = info.streams.find((s) => s.index === streamIndex);
    if (stream?.type !== 'subtitle') {
      throw new Vid2ContextError('bad-request', `Stream ${streamIndex} is not a subtitle stream.`, {
        hint: `Subtitle streams in this file: ${subs.map((s) => s.index).join(', ') || 'none'}.`,
      });
    }
    if (!stream.codec || !TEXT_SUBTITLE_CODECS.has(stream.codec)) {
      throw new Vid2ContextError(
        'bad-request',
        `Stream ${streamIndex} is an image-based subtitle (${stream.codec ?? 'unknown'}).`,
        {
          hint: 'Only text subtitles can be extracted; pick another stream or transcribe the audio.',
        },
      );
    }
  }
  const res = await runProcess(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      // Keep container timestamps: without this ffmpeg rebases output to the
      // earliest stream start (Opus pre-skip, AAC priming) and cues drift.
      '-copyts',
      ...inputGuards(target),
      '-i',
      target,
      '-map',
      `0:${stream.index}`,
      '-c:s',
      'webvtt',
      '-f',
      'webvtt',
      'pipe:1',
    ],
    {
      network: isUrlInput(target),
      label: 'ffmpeg subtitle extraction',
      captureStdout: true,
      maxStdoutBytes: 32 * 1024 * 1024,
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
      signal: ctx.signal,
    },
  );
  const text = new TextDecoder().decode(res.stdout);
  if (!text.startsWith('WEBVTT')) {
    throw new Vid2ContextError('upstream', 'ffmpeg did not produce WebVTT output for the subtitle stream.', {
      hint: 'Update ffmpeg, or extract the subtitles with another tool.',
    });
  }
  return text;
}
