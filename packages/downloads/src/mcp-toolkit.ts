/**
 * MCP tools for the media toolkit: `get_caption_options`, `download_captions`,
 * `grab_frames`, `export_clip` and `download_batch`. Like `download_media`
 * they write files on the machine the server runs on, so only the local stdio
 * server (which passes a downloader built with a registry) lists them.
 * `registerDownloadTools` calls `registerToolkitTools`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { attemptsOf, type Ctx, LINE_CHARS_RANGE, LINES_RANGE, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import type { BatchItem } from './batch.ts';
import { CAPTION_FORMATS, CAPTION_MODES, CAPTION_VIA, type CaptionTracks } from './captions.ts';
import { ANIMATION_FORMATS, FRAME_FORMATS } from './clips.ts';
import { AUDIO_FORMATS, clock, VIDEO_CONTAINERS } from './options.ts';
import { downloadPolicy, NOTICE } from './policy.ts';
import { mb } from './summary.ts';
import { normalizeToolkitRequest, type TaskResult, type ToolkitFile, toolkitOf } from './toolkit.ts';
import type { Downloader } from './types.ts';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function toolError(err: unknown): ToolResult {
  const e = err instanceof Vid2ContextError ? err : undefined;
  const payload = {
    error: e?.code ?? 'error',
    message: err instanceof Error ? err.message : String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
    attempts: attemptsOf(err),
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** Readable summary of a caption track list. */
export function tracksSummary(t: CaptionTracks): string {
  const lines = [
    t.title ? `Title: ${t.title}` : undefined,
    t.tracks.length
      ? `Tracks:\n${t.tracks.map((x) => `  ${x.language.padEnd(8)} ${x.auto ? 'auto   ' : 'creator'} ${x.name}${x.translatable ? ' (translatable)' : ''}`).join('\n')}`
      : 'Tracks: none',
    t.translationTargets.length
      ? `Machine translation into ${t.translationTargets.length} languages: ${t.translationTargets
          .slice(0, 30)
          .map((x) => x.language)
          .join(', ')}${t.translationTargets.length > 30 ? ', ...' : ''}`
      : undefined,
    `Speech-to-text fallback: ${t.speechToText ? 'available' : 'not configured'}`,
    ...t.notes.map((n) => `Note: ${n}`),
  ];
  return lines.filter(Boolean).join('\n');
}

function fileLine(f: ToolkitFile): string {
  const inside = f.entries?.length ? `, ${f.entries.length} files: ${f.entries.map((e) => e.name).join(', ')}` : '';
  return `Saved ${f.path} (${mb(f.bytes)}${f.durationSec ? `, ${clock(f.durationSec)}` : ''}${inside})${f.warnings.length ? `\n  Note: ${f.warnings.join(' ')}` : ''}`;
}

function itemLines(items: BatchItem[]): string[] {
  return items.map(
    (i) =>
      `${i.index + 1}. ${i.status === 'done' ? `saved ${i.file?.filename} (${mb(i.file?.bytes)})` : `${i.status}: ${i.input}${i.error ? `: ${i.error.message}${i.error.hint ? ` (${i.error.hint})` : ''}` : ''}`}`,
  );
}

export interface ToolkitToolDeps {
  ctx: Ctx;
  downloader: Downloader;
}

export function registerToolkitTools(server: McpServer, deps: ToolkitToolDeps): void {
  const toolkit = toolkitOf(deps.downloader);
  if (!toolkit) return;
  const { downloader } = deps;

  const enabled = (ctx: Ctx) => {
    const policy = downloadPolicy(ctx.env);
    if (!policy.enabled)
      throw new Vid2ContextError('unavailable', policy.reason ?? 'Downloads are off.', {
        hint: 'Unset VID2CONTEXT_DOWNLOADS=0 to allow them.',
      });
  };

  const ctxOf = (extra: Extra): Ctx => ({ ...deps.ctx, signal: extra.signal ?? deps.ctx.signal });
  const progress = (extra: Extra) => {
    const token = extra._meta?.progressToken;
    let last = 0;
    return (percent: number | undefined, message: string) => {
      if (token === undefined) return;
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      extra
        .sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: Math.round(percent ?? 0), total: 100, message },
        })
        .catch(() => undefined);
    };
  };

  /** Run one toolkit request and turn the result into a tool answer. */
  const runTask = async (raw: Record<string, unknown>, kind: 'captions' | 'frames' | 'animation' | 'batch', extra: Extra) => {
    const ctx = ctxOf(extra);
    try {
      enabled(ctx);
      const req = normalizeToolkitRequest(raw, kind, ctx.env);
      const dir = downloader.outputDir(ctx, typeof raw.dir === 'string' ? raw.dir : undefined);
      const notify = progress(extra);
      const result: TaskResult = await toolkit.run(req, ctx, {
        dir,
        onProgress: (p) =>
          notify(
            p.percent,
            `${p.phase === 'processing' ? (p.step ?? 'processing') : p.phase}${p.step && p.phase !== 'processing' ? ` ${p.step}` : ''}`,
          ),
      });
      const lines: string[] = [];
      if (result.file) lines.push(fileLine(result.file));
      if (result.items) {
        lines.push(...itemLines(result.items));
        if (!result.file) {
          const done = result.items.filter((i) => i.status === 'done').length;
          lines.push(`${done} of ${result.items.length} saved to ${dir}`);
        }
      }
      for (const w of result.warnings ?? []) lines.push(`Note: ${w}`);
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: {
          dir,
          ...(result.file ? { file: result.file } : {}),
          ...(result.items ? { items: result.items } : {}),
        },
      };
    } catch (err) {
      return toolError(err);
    }
  };

  const dirField = z.string().optional().describe('Folder to save to: absolute, ~/..., or relative to the default folder');
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  server.registerTool(
    'get_caption_options',
    {
      title: 'List caption tracks for download',
      description:
        'Every caption track of one video (YouTube, any site yt-dlp reads, or a local file with sidecar or embedded subtitles): language, name, creator or automatic, ' +
        'which provider lists it, the languages the platform can machine-translate into, and whether speech-to-text can make a transcript when there are none. ' +
        'Nothing is downloaded. Call it before download_captions.',
      inputSchema: { url: z.string().min(1).describe('Video URL, YouTube id or local file path') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      const ctx = ctxOf(extra);
      try {
        enabled(ctx);
        const tracks = await toolkit.captionTracks(args.url, ctx);
        return {
          content: [{ type: 'text', text: tracksSummary(tracks) }],
          structuredContent: tracks as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'download_captions',
    {
      title: 'Download captions or subtitles',
      description:
        `Save the captions of a video as ${CAPTION_FORMATS.filter((f) => f !== 'original').join(', ')} or the original file the site serves, to a folder on this machine; returns the path. ` +
        'offsetSec retimes the cues, maxLineChars and maxLines reflow them, and secondary adds a second language under each caption. ' +
        'Works for every source vid2context reads, through its transcript pipeline (no yt-dlp needed), with yt-dlp as a second path; ' +
        'for a video without captions, mode auto (default) transcribes the audio with speech-to-text. ' +
        'languages: one or several codes, or ["all"] for every track; several files come as one .zip. ' +
        `Files go to dir, else VID2CONTEXT_DOWNLOAD_DIR, else ~/Downloads/vid2context.`,
      inputSchema: {
        url: z.string().min(1).describe('Video URL, YouTube id or local file path'),
        languages: z
          .array(z.string())
          .optional()
          .describe('Language codes, e.g. ["en","de"], or ["all"]. Default: the spoken language'),
        format: z
          .enum(CAPTION_FORMATS as [string, ...string[]])
          .optional()
          .describe(`${CAPTION_FORMATS.join(', ')} (default srt; original keeps the site's file)`),
        offsetSec: z.number().optional().describe('Shift every cue by this many seconds (negative: earlier); timed formats only'),
        maxLineChars: z
          .number()
          .int()
          .min(LINE_CHARS_RANGE.min)
          .max(LINE_CHARS_RANGE.max)
          .optional()
          .describe('Longest caption line in characters (cue formats, default 42)'),
        maxLines: z.number().int().min(LINES_RANGE.min).max(LINES_RANGE.max).optional().describe('Most lines per cue (default 2)'),
        secondary: z.string().optional().describe('A second language shown under each caption, e.g. "de" (bilingual formats)'),
        mode: z
          .enum(CAPTION_MODES)
          .optional()
          .describe('auto (captions, else speech-to-text; default), captions (never transcribe), stt (always transcribe)'),
        via: z.enum(CAPTION_VIA).optional().describe('auto (default), pipeline or ytdlp'),
        allowAuto: z.boolean().optional().describe("Accept the platform's automatic captions. Default true"),
        allowTranslated: z.boolean().optional().describe("Accept the platform's machine translation. Default true"),
        timestamps: z.boolean().optional().describe('txt only: one "[m:ss] line" per caption'),
        zip: z.boolean().optional().describe('Return a .zip even for one file'),
        dir: dirField,
      },
      annotations,
    },
    async (args, extra) => runTask(args, 'captions', extra),
  );

  server.registerTool(
    'grab_frames',
    {
      title: 'Grab still frames from a video',
      description:
        'Save still images (png default, or jpg) of a video at given times to a folder on this machine. One time gives one image, several a .zip. ' +
        'Web videos are downloaded first (only the needed part when the times are close together). ' +
        `Files go to dir, else VID2CONTEXT_DOWNLOAD_DIR, else ~/Downloads/vid2context. ${NOTICE}`,
      inputSchema: {
        url: z.string().min(1).describe('Video URL, YouTube id or local file path'),
        times: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .describe('Times: seconds, m:ss or h:mm:ss'),
        format: z.enum(FRAME_FORMATS).optional().describe('png (default) or jpg'),
        width: z.number().int().min(16).optional().describe('Width in pixels; default the source size'),
        quality: z.string().optional().describe('Download size for web videos (smaller side), default 1080'),
        zip: z.boolean().optional().describe('Return a .zip even for one frame'),
        dir: dirField,
      },
      annotations,
    },
    async (args, extra) => runTask(args, 'frames', extra),
  );

  server.registerTool(
    'export_clip',
    {
      title: 'Export an animated GIF or WebP',
      description:
        'Save a short part of a video as an animated GIF (default) or WebP to a folder on this machine. ' +
        'from and to are seconds or m:ss (default 5 s from from); fps default 10 and width default 480, both capped by the server limits (VID2CONTEXT_MAX_CLIP_*). ' +
        `For a video clip with sound use download_media with from and to. ${NOTICE}`,
      inputSchema: {
        url: z.string().min(1).describe('Video URL, YouTube id or local file path'),
        from: z.union([z.string(), z.number()]).optional().describe('Start: seconds, m:ss or h:mm:ss. Default 0'),
        to: z.union([z.string(), z.number()]).optional().describe('End. Default from + 5 s'),
        format: z.enum(ANIMATION_FORMATS).optional().describe('gif (default) or webp'),
        fps: z.number().int().min(1).optional().describe('Frames per second, default 10'),
        width: z.number().int().min(16).optional().describe('Width in pixels, default 480'),
        loop: z.boolean().optional().describe('Repeat forever (default true)'),
        dir: dirField,
      },
      annotations,
    },
    async (args, extra) => runTask(args, 'animation', extra),
  );

  server.registerTool(
    'download_batch',
    {
      title: 'Download many videos, audio or captions',
      description:
        'Save several videos at once: a list of URLs, playlists or channels (expanded up to limit), each as video, audio or captions only. ' +
        'Failed items are reported and do not stop the rest. zip: true returns one .zip with every file. ' +
        `Video formats: ${VIDEO_CONTAINERS.join(', ')}; audio: ${AUDIO_FORMATS.join(', ')}; captions: ${CAPTION_FORMATS.join(', ')}. ${NOTICE}`,
      inputSchema: {
        urls: z.array(z.string().min(1)).min(1).describe('Video, playlist or channel URLs, YouTube ids or file paths'),
        kind: z.enum(['video', 'audio', 'captions']).optional().describe('What each video becomes. Default video'),
        format: z.string().optional().describe('Format for that kind, e.g. mp4, mp3 or srt'),
        quality: z.string().optional().describe('Video: 1080, 720, ...; mp3: kbps'),
        languages: z.array(z.string()).optional().describe('captions: language codes or ["all"]'),
        mode: z.enum(CAPTION_MODES).optional().describe('captions: auto, captions or stt'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Most videos in total. Default and cap: VID2CONTEXT_MAX_PLAYLIST_ITEMS'),
        playlist: z.boolean().optional().describe('Expand video links that also name a playlist (watch?v=...&list=...)'),
        zip: z.boolean().optional().describe('Return one .zip with every saved file'),
        dir: dirField,
      },
      annotations,
    },
    async (args, extra) => runTask(args, 'batch', extra),
  );
}
