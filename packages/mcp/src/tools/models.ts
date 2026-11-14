/**
 * list_models: every rung this server knows (speech-to-text, LLM, embedding,
 * video, visual), as the ModelInfo shape from docs/prompts/SHARED-CONTRACTS.md
 * section 3. Built from rung definitions only: env var names, never values.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  canStream,
  type Env,
  isRungEnabled,
  keylessAllowed,
  type LlmRung,
  type Policy,
  type Registry,
  type Rung,
} from '@vid2context/core';
import { z } from 'zod';
import { structured } from '../shared.ts';
import type { ToolDeps } from './video.ts';

export type ModelKind = 'llm' | 'stt' | 'embed' | 'video' | 'visual';
export const MODEL_KINDS: [ModelKind, ...ModelKind[]] = ['llm', 'stt', 'embed', 'video', 'visual'];

const POLICIES: Policy[] = ['free', 'local-only', 'quality'];

export interface ModelInfo {
  id: string;
  kind: ModelKind;
  label: string;
  service: string;
  provider: string;
  model: string;
  tier: 'local' | 'free' | 'keyless' | 'paid';
  quality: number;
  capabilities: string[];
  contextTokens?: number;
  enabled: boolean;
  requires: string[];
}

function rungsOf(registry: Registry, kind: ModelKind, env: Env): Rung[] {
  switch (kind) {
    case 'llm':
      return registry.llmRungs(env);
    case 'stt':
      return registry.sttRungs(env);
    case 'embed':
      return registry.embedRungs(env);
    case 'video':
      return registry.videoRungs(env);
    case 'visual':
      return registry.visualRungs(env);
  }
}

/** ModelInfo for every rung of the given kinds. Reads env only to decide `enabled`; never copies a value. */
export function listModels(registry: Registry, env: Env, kinds: ModelKind[] = MODEL_KINDS): ModelInfo[] {
  const keyless = keylessAllowed(env);
  return kinds.flatMap((kind) =>
    rungsOf(registry, kind, env).map((r) => {
      const llm = kind === 'llm' ? (r as LlmRung) : undefined;
      const capabilities = [...r.capabilities];
      if (llm && canStream(llm) && !capabilities.includes('stream')) capabilities.push('stream');
      return {
        id: r.id,
        kind,
        label: r.model.split('/').pop() || r.model,
        service: r.service,
        provider: r.provider,
        model: r.model,
        tier: r.tier,
        quality: r.quality,
        capabilities,
        ...(llm?.contextTokens !== undefined ? { contextTokens: llm.contextTokens } : {}),
        enabled: isRungEnabled(r, env) && (r.tier !== 'keyless' || keyless),
        requires: [...r.requires],
      };
    }),
  );
}

export function registerModelTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description:
        'The models (rungs) this server can use for speech-to-text, LLM, embedding, video and visual work, in free-first order: tier (local, free, keyless, paid), quality 1 to 5, ' +
        'capabilities (json, tools, vision, stream, ...), context window, whether it is enabled, and the names of the env vars that would enable it. Never shows key values. ' +
        'Cost: about 80 tokens per model; filter with kind.',
      inputSchema: { kind: z.enum(MODEL_KINDS).optional().describe('Only this kind of model. Default: all kinds') },
      outputSchema: {
        models: z.array(
          z.object({
            id: z.string(),
            kind: z.enum(MODEL_KINDS),
            label: z.string(),
            service: z.string(),
            provider: z.string(),
            model: z.string(),
            tier: z.enum(['local', 'free', 'keyless', 'paid']),
            quality: z.number(),
            capabilities: z.array(z.string()),
            contextTokens: z.number().optional(),
            enabled: z.boolean(),
            requires: z.array(z.string()),
          }),
        ),
        defaultPolicy: z.enum(['free', 'local-only', 'quality']),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (args) =>
      structured({
        models: listModels(deps.registry, deps.ctx.env, args.kind ? [args.kind] : MODEL_KINDS),
        defaultPolicy: POLICIES.find((p) => p === deps.ctx.env.VID2CONTEXT_POLICY) ?? 'free',
      }),
  );
}
