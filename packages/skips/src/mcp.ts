/**
 * MCP tool `get_skip_segments`. Item 44 (or the integration pass) wires it
 * into the server with one line: `registerSkipsTools(server, { registry, ctx })`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  attemptsOf,
  type Ctx,
  getVideoContext,
  type Registry,
  type Storage,
  type Transcript,
  Vid2ContextError,
} from '@vid2context/core';
import { z } from 'zod';
import { buildReport } from './report.ts';
import { getSkipSegments, SKIP_CATEGORIES } from './sponsorblock.ts';

export interface SkipsToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** Saved contexts: a stored transcript is used for the coverage numbers without fetching it again. */
  storage?: Storage | null;
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

export function registerSkipsTools(server: McpServer, deps: SkipsToolDeps): void {
  server.registerTool(
    'get_skip_segments',
    {
      title: 'Get sponsor and skip segments',
      description:
        'Community-marked SponsorBlock segments of a YouTube video: sponsor reads, self-promotion, subscribe reminders, intros, outros, previews and filler, ' +
        'each with its [m:ss] range, a timestamp URL and how much of the transcript it covers (lines, word share and the first words). ' +
        'Use it to leave ad copy out of summaries and briefs: never cite text inside these segments as a claim about the topic. ' +
        `Default categories: sponsor, selfpromo, interaction, intro, outro, preview, filler. All: ${SKIP_CATEGORIES.join(', ')}. ` +
        'poi_highlight comes back as `highlight` (a point, not a skip); a whole-video label comes back as `fullVideo`. ' +
        'Other platforms return no segments. Results carry the SponsorBlock attribution (CC BY-NC-SA 4.0).',
      inputSchema: {
        url: z.string().min(1).describe('YouTube video URL or id'),
        categories: z
          .array(z.enum(SKIP_CATEGORIES))
          .optional()
          .describe('Categories to look up. Default: the env default or the seven above'),
      },
    },
    async (args, extra) => {
      const ctx: Ctx = { ...deps.ctx, signal: extra.signal ?? deps.ctx.signal };
      try {
        const { ref } = deps.registry.resolve(args.url);
        const lookup = await getSkipSegments(ref, ctx, args.categories ? { categories: args.categories } : {});
        let transcript: Transcript | undefined;
        let durationSec: number | undefined;
        let note: string | undefined;
        if (lookup.segments.length > 0) {
          try {
            const context = await getVideoContext(
              deps.registry,
              args.url,
              { mode: 'captions', storage: deps.storage ?? null },
              ctx,
            );
            transcript = context.transcript;
            durationSec = context.metadata.durationSec;
          } catch (err) {
            note = `Transcript coverage is unavailable: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        const report = buildReport(ref, lookup, { ctx, transcript, durationSec, note });
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
