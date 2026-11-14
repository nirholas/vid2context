/**
 * Helpers shared by the agentic features: tool results, the context header,
 * client capability checks and per-server state.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  attemptsOf,
  type Ctx,
  formatTimestamp,
  type Registry,
  type Storage,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';

export interface AgenticDeps {
  registry: Registry;
  ctx: Ctx;
  /** Cache and library backend. Default: the registry's enabled storage backend, opened once. */
  storage?: (ctx: Ctx) => Promise<Storage | null>;
}

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

/** Same error shape as packages/mcp `toolError`: code, message, hint and attempts as JSON, with isError. */
export function toolError(err: unknown): ToolResult {
  const e = err instanceof Vid2ContextError ? err : undefined;
  const payload = {
    error: e?.code ?? 'error',
    message: err instanceof Error ? err.message : String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
    attempts: attemptsOf(err),
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/**
 * The header packages/mcp puts before text transcripts (same lines, same
 * order), so a transcript from choose_caption_track reads exactly like one
 * from get_transcript. It lives here too because packages/mcp mounts this
 * package; importing it back would make the two packages depend on each other.
 */
export function contextHeader(c: VideoContext): string {
  const m = c.metadata;
  const lines = [
    `Title: ${m.title}`,
    m.channel ? `Channel: ${m.channel.name}` : undefined,
    m.ref.url ? `URL: ${m.ref.url}` : undefined,
    m.durationSec ? `Duration: ${formatTimestamp(m.durationSec)}` : undefined,
    `Transcript: ${c.transcript.origin}, ${c.transcript.language}${c.transcript.translated ? ', machine-translated' : ''} (${c.transcript.producer})`,
    m.chapters.length > 0
      ? `Chapters: ${m.chapters.map((ch) => `${formatTimestamp(ch.startSec)} ${ch.title}`).join(' | ')}`
      : undefined,
  ];
  return `${lines.filter(Boolean).join('\n')}\n\n`;
}

/** The client declared `sampling` at initialization. */
export function clientSupportsSampling(server: McpServer): boolean {
  return Boolean(server.server.getClientCapabilities()?.sampling);
}

/** The client declared form-mode elicitation (an empty `elicitation: {}` means form mode). */
export function clientSupportsElicitation(server: McpServer): boolean {
  const e = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  if (!e) return false;
  return Boolean(e.form) || Object.keys(e).length === 0;
}

/** The deps each server was set up with, so helpers such as confirmExpensive can read ctx.env. */
const serverDeps = new WeakMap<McpServer, AgenticDeps>();

export function rememberDeps(server: McpServer, deps: AgenticDeps): void {
  serverDeps.set(server, deps);
}

export function depsOf(server: McpServer): AgenticDeps | undefined {
  return serverDeps.get(server);
}

/** A per-call Ctx: a shallow copy carrying the call's abort signal, so nothing per-request lives on the server. */
export function callCtx(ctx: Ctx, signal?: AbortSignal): Ctx {
  return { ...ctx, signal: signal ?? ctx.signal };
}

/** Open storage once per registration: deps.storage when given, else the registry's enabled backend. */
export function storageOpener(deps: AgenticDeps): (ctx: Ctx) => Promise<Storage | null> {
  if (deps.storage) return deps.storage;
  let opened: Promise<Storage | null> | undefined;
  return (ctx) => {
    opened ??= deps.registry.openStorage(ctx).catch((err: unknown) => {
      ctx.log.warn('could not open storage, continuing without a cache', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    return opened;
  };
}
