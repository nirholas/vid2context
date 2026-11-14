/**
 * MCP tools for note exports. The MCP server calls registerExporterTools once.
 *
 *   export_obsidian  { urls?, collection?, vaultPath, folder?, overwrite? }  Node only: writes notes on this machine
 *   export_notion    { urls?, collection?, parentPageId? }                   creates or updates Notion pages
 *
 * Failures come back as tool results with isError and the standard JSON body
 * (error code, message, hint, attempts), never as protocol errors.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { attemptsOf, type Ctx, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import { loadContexts } from './load.ts';
import { exportNotion, notionConfig } from './notion.ts';
import { renderObsidian } from './obsidian.ts';

export interface ExporterToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** Library storage, needed for the `collection` argument. */
  storage?: Storage | null;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

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

export function registerExporterTools(server: McpServer, deps: ExporterToolDeps): void {
  const callCtx = (signal?: AbortSignal): Ctx => ({ ...deps.ctx, signal: signal ?? deps.ctx.signal });
  const selection = {
    urls: z.array(z.string().min(1)).optional().describe('Video, playlist, channel or feed URLs to export'),
    collection: z.string().optional().describe('A saved collection id to export'),
  };

  if (deps.ctx.runtime === 'node') {
    server.registerTool(
      'export_obsidian',
      {
        title: 'Export to an Obsidian vault',
        description:
          'Write one Markdown note per video into a folder of an Obsidian vault on this machine: frontmatter properties, chapters as headings, ' +
          'paragraphs prefixed with [m:ss] timestamp links, plus an index note with [[wikilinks]] when a collection is exported. ' +
          'Notes vid2context wrote before are updated; other existing notes are never replaced unless overwrite is true.',
        inputSchema: {
          ...selection,
          vaultPath: z.string().min(1).describe('Absolute path of the vault (or any folder) to write into'),
          folder: z.string().optional().describe('Folder inside the vault. Default: the collection name, or "vid2context"'),
          overwrite: z
            .boolean()
            .optional()
            .describe('Replace existing notes not written by vid2context for the same video. Default false'),
        },
      },
      async (args, extra) => {
        try {
          const ctx = callCtx(extra.signal);
          const { writeObsidian } = await import('./node.ts');
          const loaded = await loadContexts(deps, { inputs: args.urls, collectionId: args.collection }, ctx);
          const files = renderObsidian(loaded.contexts, { collection: loaded.collection, folder: args.folder });
          const written = await writeObsidian(files, args.vaultPath, { overwrite: args.overwrite });
          return json({ written, missing: loaded.missing });
        } catch (err) {
          return toolError(err);
        }
      },
    );
  }

  server.registerTool(
    'export_notion',
    {
      title: 'Export to Notion',
      description:
        'Create one Notion page per video under a parent page (chapters as headings, paragraphs with timestamp links, a bookmark to the video). ' +
        'Re-exporting updates the same pages instead of duplicating them. Needs NOTION_TOKEN; the parent page comes from parentPageId or NOTION_PARENT_PAGE_ID.',
      inputSchema: {
        ...selection,
        parentPageId: z
          .string()
          .optional()
          .describe('Notion page id or URL to create the pages under. Default: NOTION_PARENT_PAGE_ID'),
      },
    },
    async (args, extra) => {
      try {
        const ctx = callCtx(extra.signal);
        notionConfig({ parentPageId: args.parentPageId }, ctx);
        const loaded = await loadContexts(deps, { inputs: args.urls, collectionId: args.collection }, ctx);
        const pages = await exportNotion(loaded.contexts, { parentPageId: args.parentPageId }, ctx);
        return json({ pages, missing: loaded.missing });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
