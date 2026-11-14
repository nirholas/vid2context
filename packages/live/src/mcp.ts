/**
 * MCP tool `watch_live` (docs/contracts/mcp-tools.md, wave 2). The tool call
 * stays open while the stream is followed; when the client sent a
 * progressToken, every new chunk of lines (and every status) goes out as a
 * progress notification, and the result is the whole rolling transcript.
 * Item 44, or the integration pass, calls registerLiveTools from createServer.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { attemptsOf, type Ctx, type Registry, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import { formatLiveLine, latestLines } from './format.ts';
import type { AudioExtractor, LiveDeps, LiveEvent } from './types.ts';
import { watchLive } from './watch.ts';

export const WATCH_LIVE_DEFAULT_MINUTES = 10;
export const WATCH_LIVE_MAX_MINUTES = 60;

export interface LiveToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** ffmpeg-backed extractor from '@vid2context/live/node'. Without it the tool answers with a `no-provider` error. */
  extractAudio?: AudioExtractor;
  /** Waits between playlist polls; defaults to a real timer. */
  sleep?: LiveDeps['sleep'];
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

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

const REASONS: Record<Extract<LiveEvent, { type: 'done' }>['reason'], string> = {
  ended: 'the stream ended',
  'max-minutes': 'maxMinutes reached',
  cancelled: 'cancelled',
  lost: 'the stream became unreachable',
};

export function registerLiveTools(server: McpServer, deps: LiveToolDeps): void {
  server.registerTool(
    'watch_live',
    {
      title: 'Watch a live stream',
      description:
        'Transcribe a live stream (a live YouTube video or an HLS .m3u8 URL) while it runs. New lines arrive about every 30 seconds as progress ' +
        'notifications; the result is the full transcript with [stream time | UTC] stamps when the stream ends or maxMinutes pass. ' +
        `Default ${WATCH_LIVE_DEFAULT_MINUTES} minutes, at most ${WATCH_LIVE_MAX_MINUTES}. For recordings use get_transcript.`,
      inputSchema: {
        url: z.string().min(1).describe('Live YouTube URL or HLS (.m3u8) URL'),
        maxMinutes: z
          .number()
          .positive()
          .optional()
          .describe(`Minutes to follow the stream. Default ${WATCH_LIVE_DEFAULT_MINUTES}, capped at ${WATCH_LIVE_MAX_MINUTES}`),
      },
    },
    async (args, extra) => {
      const maxMinutes = Math.min(args.maxMinutes ?? WATCH_LIVE_DEFAULT_MINUTES, WATCH_LIVE_MAX_MINUTES);
      const ctx: Ctx = { ...deps.ctx, signal: extra.signal };
      const token = extra._meta?.progressToken;
      const started = Date.now();
      let lastProgress = 0;
      const progress = async (message: string) => {
        if (token === undefined) return;
        // Progress must increase with every notification.
        lastProgress = Math.max(lastProgress + 0.001, (Date.now() - started) / 1000);
        try {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress: Number(lastProgress.toFixed(3)), total: maxMinutes * 60, message },
          });
        } catch (err) {
          ctx.log.debug('watch_live progress notification failed', { error: err instanceof Error ? err.message : String(err) });
        }
      };

      const lines: Extract<LiveEvent, { type: 'segment' }>[] = [];
      const statuses: string[] = [];
      try {
        const events = watchLive(
          args.url,
          { maxMinutes },
          { registry: deps.registry, ctx, extractAudio: deps.extractAudio, sleep: deps.sleep },
        );
        let batch = 0;
        for await (const e of events) {
          if (e.type === 'segment') {
            lines.push(e);
            batch++;
            continue;
          }
          if (batch > 0) {
            await progress(latestLines(lines, Math.min(batch, 8)));
            batch = 0;
          }
          if (e.type === 'status') {
            statuses.push(e.message);
            await progress(e.message);
            continue;
          }
          const t = e.transcript;
          const header = [
            `Live stream: ${t.ref.url ?? t.ref.input}`,
            `Stopped: ${REASONS[e.reason]} after ${Math.round((Date.now() - started) / 1000)} s`,
            `Transcript: stt, ${t.language} (${t.producer}), ${t.segments.length} segments`,
            e.resumeSequence !== undefined ? `Resume from media sequence: ${e.resumeSequence}` : undefined,
            'Times are [stream time | UTC wall clock].',
          ]
            .filter(Boolean)
            .join('\n');
          const notes = statuses.filter((s) => !s.startsWith('Transcribed ')).map((s) => `- ${s}`);
          const body = lines.map(formatLiveLine).join('\n') || '(no speech was transcribed)';
          return {
            content: [{ type: 'text', text: `${header}\n${notes.length ? `\nNotes:\n${notes.join('\n')}\n` : ''}\n${body}` }],
          };
        }
        return toolError(new Vid2ContextError('upstream', 'The live watcher stopped without a final transcript.'));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
