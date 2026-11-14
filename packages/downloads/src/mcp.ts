/**
 * MCP tools `get_media_options` and `download_media`. They save files on the
 * machine the server runs on, so only the local stdio server registers them:
 * its bin passes a downloader, the remote Streamable HTTP server passes none
 * and the tools are never listed there. Item 44 (or the integration pass)
 * wires them with `registerDownloadTools(server, { registry, ctx, downloader })`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { attemptsOf, type Ctx, expandInput, limits, type Registry, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import {
  AUDIO_FORMATS,
  AUDIO_QUALITIES,
  clock,
  normalizeRequest,
  SPONSOR_CATEGORIES,
  VIDEO_CONTAINERS,
  VIDEO_QUALITIES,
} from './options.ts';
import { downloadPolicy, NOTICE } from './policy.ts';
import { mb, optionsSummary } from './summary.ts';
import type { DownloadedFile, Downloader } from './types.ts';

export interface DownloadToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** Omit on servers that must not write files (remote MCP): the tools are then not registered. */
  downloader?: Downloader;
}

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

export function registerDownloadTools(server: McpServer, deps: DownloadToolDeps): void {
  const downloader = deps.downloader;
  if (!downloader) return;

  const enabled = (ctx: Ctx) => {
    const policy = downloadPolicy(ctx.env);
    if (!policy.enabled)
      throw new Vid2ContextError('unavailable', policy.reason ?? 'Downloads are off.', {
        hint: 'Unset VID2CONTEXT_DOWNLOADS=0 to allow them.',
      });
  };

  server.registerTool(
    'get_media_options',
    {
      title: 'Get video and audio download options',
      description:
        'Qualities, formats and estimated file sizes for downloading one video (YouTube or any site yt-dlp supports, or a local file): ' +
        'video sizes per quality for mp4, webm and mkv, audio sizes for mp3 (by bitrate), m4a, opus, flac and wav, plus chapters and subtitle languages. ' +
        'Nothing is downloaded. Call it before download_media to pick a quality that fits.',
      inputSchema: { url: z.string().min(1).describe('Video URL, YouTube id or local file path') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      const ctx: Ctx = { ...deps.ctx, signal: extra.signal ?? deps.ctx.signal };
      try {
        enabled(ctx);
        const options = await downloader.probe(args.url, ctx);
        return {
          content: [{ type: 'text', text: optionsSummary(options) }],
          structuredContent: options as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'download_media',
    {
      title: 'Download a video or its audio',
      description:
        'Save a video as mp4, webm or mkv, or its audio as mp3, m4a, opus, flac or wav, to a folder on this machine; returns the file paths. ' +
        'Works for YouTube and the other sites yt-dlp supports, and converts local files. ' +
        'Defaults: video mp4 up to 1080p (H.264 + stereo AAC, plays everywhere), audio mp3 at the best VBR quality, with title, cover art and chapters embedded. ' +
        'Keep a part with from/to (seconds or m:ss) or chapter (index or title); cut sponsor reads with removeSegments (YouTube). ' +
        'A playlist or channel URL downloads its first `limit` videos. ' +
        `Files go to dir, else VID2CONTEXT_DOWNLOAD_DIR, else ~/Downloads/vid2context. ${NOTICE}`,
      inputSchema: {
        url: z.string().min(1).describe('Video, playlist or channel URL, YouTube id, or local file path'),
        kind: z.enum(['video', 'audio']).optional().describe('video or audio. Default: from format, else video'),
        format: z
          .enum([...VIDEO_CONTAINERS, ...AUDIO_FORMATS])
          .optional()
          .describe('mp4 (default for video), webm, mkv, mp3 (default for audio), m4a, opus, flac, wav'),
        quality: z
          .string()
          .optional()
          .describe(
            `Video: ${VIDEO_QUALITIES.join(', ')} (smaller side in pixels; default 1080). Audio: ${AUDIO_QUALITIES.join(', ')} (mp3 kbps; default best)`,
          ),
        from: z.string().optional().describe('Start of the part to keep: seconds, m:ss or h:mm:ss'),
        to: z.string().optional().describe('End of the part to keep'),
        chapter: z.string().optional().describe('Keep one chapter: 0-based index or title (see get_media_options)'),
        exactCuts: z
          .boolean()
          .optional()
          .describe('Re-encode at the cut points so a trimmed video starts exactly at from (slower)'),
        subtitles: z.array(z.string()).optional().describe('Subtitle languages to embed in a video, e.g. ["en"]'),
        removeSegments: z.array(z.enum(SPONSOR_CATEGORIES)).optional().describe('SponsorBlock categories to cut out (YouTube)'),
        embedThumbnail: z.boolean().optional().describe('Cover art. Default true'),
        embedMetadata: z.boolean().optional().describe('Title, channel and date tags. Default true'),
        embedChapters: z.boolean().optional().describe('Chapter markers. Default true'),
        dir: z.string().optional().describe('Folder to save to: absolute, ~/..., or relative to the default folder'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Playlists and channels: how many videos to download. Default 10'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const ctx: Ctx = { ...deps.ctx, signal: extra.signal ?? deps.ctx.signal };
      const token = extra._meta?.progressToken;
      const notify = async (progress: number, message: string) => {
        if (token === undefined) return;
        try {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress, total: 100, message },
          });
        } catch {
          // A client that stopped listening must not fail the download.
        }
      };
      try {
        enabled(ctx);
        const base = normalizeRequest({ ...args, input: args.url });
        const dir = downloader.outputDir(ctx, args.dir);
        const { ref } = deps.registry.resolve(args.url);
        const inputs =
          ref.kind === 'video'
            ? [args.url]
            : (
                await expandInput(deps.registry, args.url, ctx, {
                  limit: Math.min(args.limit ?? 10, limits(ctx.env).maxPlaylistItems),
                })
              ).map((r) => r.url ?? r.id);
        const saved: DownloadedFile[] = [];
        const failed: { input: string; error: string; hint?: string }[] = [];
        for (const [i, input] of inputs.entries()) {
          const share = 100 / inputs.length;
          let lastSent = 0;
          try {
            const file = await downloader.download({ ...base, input }, ctx, {
              dir,
              onProgress: (p) => {
                const now = Date.now();
                if (now - lastSent < 1000 && p.phase !== 'finished') return;
                lastSent = now;
                const overall = Math.round(i * share + ((p.percent ?? 0) / 100) * share);
                const what = p.phase === 'processing' ? (p.step ?? 'processing') : p.phase;
                void notify(
                  overall,
                  `${inputs.length > 1 ? `${i + 1}/${inputs.length} ` : ''}${what}${p.percent !== undefined ? ` ${p.percent}%` : ''}`,
                );
              },
            });
            saved.push(file);
          } catch (err) {
            if (ctx.signal?.aborted || inputs.length === 1) throw err;
            const e = err instanceof Vid2ContextError ? err : undefined;
            failed.push({ input, error: err instanceof Error ? err.message : String(err), ...(e?.hint ? { hint: e.hint } : {}) });
          }
        }
        const lines = saved.map(
          (f) =>
            `Saved ${f.path} (${mb(f.bytes)}${f.durationSec ? `, ${clock(f.durationSec)}` : ''})${f.warnings.length ? `\n  Note: ${f.warnings.join(' ')}` : ''}`,
        );
        for (const f of failed) lines.push(`Failed ${f.input}: ${f.error}${f.hint ? ` (${f.hint})` : ''}`);
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: { dir, files: saved, failed },
          ...(saved.length === 0 ? { isError: true } : {}),
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
