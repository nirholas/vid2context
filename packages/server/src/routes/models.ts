/**
 * GET /models: every rung the registry knows, enabled or not, as ModelInfo
 * (docs/prompts/SHARED-CONTRACTS.md section 3). Names of the env vars a rung
 * needs are listed; their values never are.
 */
import {
  canStream,
  type Env,
  isRungEnabled,
  keylessAllowed,
  type LlmRung,
  type Registry,
  type Rung,
  resolveChainOptions,
} from '@vid2context/core';
import { Hono } from 'hono';
import { badRequest } from '../errors.ts';
import { json, ref } from '../openapi.ts';
import type { AppEnv, RouteDeps } from '../types.ts';

export type ModelKind = 'llm' | 'stt' | 'embed' | 'video' | 'visual';
const KINDS: ModelKind[] = ['llm', 'stt', 'embed', 'video', 'visual'];

export interface ModelInfo {
  id: string;
  kind: ModelKind;
  label: string;
  service: string;
  provider: string;
  model: string;
  tier: Rung['tier'];
  quality: number;
  capabilities: string[];
  contextTokens?: number;
  enabled: boolean;
  requires: string[];
}

/** "openai/gpt-oss-120b" to "gpt-oss-120b", "@cf/meta/llama-3.1-8b-instruct" to "llama-3.1-8b-instruct". */
export function modelLabel(model: string): string {
  return model.split('/').filter(Boolean).pop() ?? model;
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

export function listModels(registry: Registry, env: Env, kinds: ModelKind[] = KINDS): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const kind of kinds) {
    for (const r of rungsOf(registry, kind, env)) {
      const llm = kind === 'llm' ? (r as LlmRung) : undefined;
      const capabilities = [...r.capabilities];
      if (llm && canStream(llm) && !capabilities.includes('stream')) capabilities.push('stream');
      out.push({
        id: r.id,
        kind,
        label: modelLabel(r.model),
        service: r.service,
        provider: r.provider,
        model: r.model,
        tier: r.tier,
        quality: r.quality,
        capabilities,
        ...(llm?.contextTokens ? { contextTokens: llm.contextTokens } : {}),
        enabled: isRungEnabled(r, env) && (r.tier !== 'keyless' || keylessAllowed(env)),
        requires: [...r.requires],
      });
    }
  }
  return out;
}

export function modelRoutes({ services, docs }: RouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  docs.add({
    method: 'get',
    path: '/api/v1/models',
    summary: 'Every model rung this server knows, enabled or not, and the default policy.',
    description: 'requires lists env var names a rung needs; values are never returned. Pass an id back as the rung of a chat request.',
    tags: ['models'],
    params: [{ name: 'kind', description: 'Only this kind.', schema: { type: 'string', enum: KINDS } }],
    responses: {
      '200': {
        description: 'Models.',
        content: json({
          type: 'object',
          properties: { models: { type: 'array', items: ref('ModelInfo') }, defaultPolicy: { type: 'string', enum: ['free', 'local-only', 'quality'] } },
          required: ['models', 'defaultPolicy'],
        }),
      },
    },
  });
  app.get('/models', (c) => {
    const env = services.ctxFor(c.req.raw).env;
    const kind = c.req.query('kind');
    if (kind && !KINDS.includes(kind as ModelKind)) throw badRequest(`Unknown kind "${kind}".`, `Use one of: ${KINDS.join(', ')}.`);
    return c.json({
      models: listModels(services.registry, env, kind ? [kind as ModelKind] : KINDS),
      defaultPolicy: resolveChainOptions({}, env).policy,
    });
  });

  return app;
}
