/**
 * MCP tools for insights. Item 44 (or the integration pass) calls
 * registerInsightsTools(server, deps) from createServer:
 *
 *   build_brief  server-side cited brief (map-reduce on a free model)
 *   extract      structured JSON from a template or JSON Schema, with verified citations
 *
 * Synthesis by the calling agent stays the default: these tools are for
 * collections too large for the agent's context, or agents without a strong
 * model. Item 44's `brief` and `buyer_guide` prompts import
 * briefInstructions() and buyerGuideInstructions() from this package.
 *
 * Failures are tool results with isError and the standard JSON error body.
 * Each call gets its own Ctx carrying its abort signal.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { attemptsOf, type Ctx, type Registry, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import { buildBrief } from './brief.ts';
import { extract } from './extract.ts';
import { loadContexts, MAX_VIDEOS, type StorageSource } from './load.ts';
import { parseBriefRequest, parseExtractRequest } from './parse.ts';
import { templates } from './templates/index.ts';

export interface InsightsToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** Saved contexts and collections. Omitted: the registry's enabled storage provider, if any. */
  storage?: StorageSource;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

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

const TEMPLATE_IDS = Object.keys(templates) as [string, ...string[]];

export function registerInsightsTools(server: McpServer, deps: InsightsToolDeps): void {
  const forCall = (signal?: AbortSignal) => {
    const ctx = { ...deps.ctx, signal: signal ?? deps.ctx.signal };
    return { registry: deps.registry, ctx, storage: deps.storage };
  };

  server.registerTool(
    'build_brief',
    {
      title: 'Build a cited brief',
      description:
        'Build a cited brief across videos on the server with a free LLM (map-reduce for large collections). Every claim cites a video, ' +
        'timestamp and quote that were checked against the transcript; points are marked consensus (two or more videos agree), ' +
        'disputed (both sides cited) or single-source, and claims that failed the check are listed separately, uncited. ' +
        'If you can read the transcripts yourself, the `brief` prompt is cheaper and usually better; use this for collections too large for your context.',
      inputSchema: {
        urls: z.array(z.string().min(1)).max(MAX_VIDEOS).optional().describe(`Up to ${MAX_VIDEOS} video URLs or ids`),
        collection: z.string().min(1).optional().describe('A saved collection id'),
        question: z
          .string()
          .max(2000)
          .optional()
          .describe('What the brief should answer, e.g. "Which G-Wagon year should I buy?"'),
        template: z.enum(TEMPLATE_IDS).optional().describe('brief (default) or buyer-guide, tutorial-steps, comparison, summary'),
        format: z
          .enum(['markdown', 'json'])
          .optional()
          .describe('markdown (default): the brief as Markdown; json: the full Brief object'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const req = parseBriefRequest({
          inputs: args.urls,
          collectionId: args.collection,
          question: args.question,
          template: args.template,
        });
        const d = forCall(extra.signal);
        const contexts = await loadContexts(req, d);
        const brief = await buildBrief(contexts, { question: req.question, template: req.template }, d);
        return text(args.format === 'json' ? JSON.stringify(brief, null, 2) : brief.markdown);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'extract',
    {
      title: 'Extract structured data',
      description:
        'Extract structured JSON from videos with a template (buyer-guide, tutorial-steps, comparison, summary, brief) or your own JSON Schema. ' +
        'The answer is validated against the schema (one repair attempt), and every citation ({videoId, startSec, quote}) is checked against the transcript: ' +
        'verified ones gain a title and timestamp url, failed ones are removed and listed in "unverified".',
      inputSchema: {
        urls: z.array(z.string().min(1)).max(MAX_VIDEOS).optional().describe(`Up to ${MAX_VIDEOS} video URLs or ids`),
        collection: z.string().min(1).optional().describe('A saved collection id'),
        template: z.enum(TEMPLATE_IDS).optional().describe('Template id; default summary when no schema is given'),
        schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('A JSON Schema (type, properties, required, items, enum, min/max limits). The result is {data, citations}.'),
        question: z.string().max(2000).optional().describe('Focus for the extraction'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const req = parseExtractRequest({
          inputs: args.urls,
          collectionId: args.collection,
          template: args.template,
          schema: args.schema,
          question: args.question,
        });
        const d = forCall(extra.signal);
        const contexts = await loadContexts(req, d);
        const result = await extract(contexts, { template: req.template, schema: req.schema, question: req.question }, d);
        return text(JSON.stringify(result, null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
