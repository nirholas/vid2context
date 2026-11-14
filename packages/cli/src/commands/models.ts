/**
 * `models`: every rung the installed providers know, grouped by tier, with
 * whether it is enabled and the env var names a disabled rung needs. Rows
 * follow ModelInfo from docs/prompts/SHARED-CONTRACTS.md section 3. Only env
 * var names are ever printed, never values.
 */
import { type Env, isRungEnabled, keylessAllowed, type Registry, type Rung, type Tier } from '@vid2context/core';
import { choice } from '../args.ts';
import { table } from '../output.ts';
import type { CommandContext } from '../runtime.ts';
import { MODEL_KINDS } from '../spec.ts';

export type ModelKind = (typeof MODEL_KINDS)[number];

export interface ModelInfo {
  id: string;
  kind: ModelKind;
  label: string;
  service: string;
  provider: string;
  model: string;
  tier: Tier;
  quality: number;
  capabilities: string[];
  contextTokens?: number;
  enabled: boolean;
  /** Env var names the rung needs. Never values. */
  requires: string[];
  /** The subset of `requires` that is not set, plus VID2CONTEXT_KEYLESS when keyless lanes are off. */
  missing: string[];
}

const TIERS: Tier[] = ['local', 'free', 'keyless', 'paid'];

export function listModels(registry: Registry, env: Env, kind?: ModelKind): ModelInfo[] {
  const byKind: Record<ModelKind, () => Rung[]> = {
    llm: () => registry.llmRungs(env),
    stt: () => registry.sttRungs(env),
    embed: () => registry.embedRungs(env),
    video: () => registry.videoRungs(env),
    visual: () => registry.visualRungs(env),
  };
  const kinds = kind ? [kind] : [...MODEL_KINDS];
  const keyless = keylessAllowed(env);
  const rows = kinds.flatMap((k) =>
    byKind[k]().map((r): ModelInfo => {
      const missing = r.requires.filter((name) => !env[name]);
      if (r.tier === 'keyless' && !keyless) missing.push('VID2CONTEXT_KEYLESS');
      const info: ModelInfo = {
        id: r.id,
        kind: k,
        label: r.model.split('/').at(-1) ?? r.model,
        service: r.service,
        provider: r.provider,
        model: r.model,
        tier: r.tier,
        quality: r.quality,
        capabilities: r.capabilities,
        enabled: isRungEnabled(r, env) && (r.tier !== 'keyless' || keyless),
        requires: r.requires,
        missing,
      };
      const ctxTokens = (r as Rung & { contextTokens?: number }).contextTokens;
      if (ctxTokens !== undefined) info.contextTokens = ctxTokens;
      return info;
    }),
  );
  return rows.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.kind.localeCompare(b.kind));
}

function why(m: ModelInfo): string {
  if (m.enabled) return '';
  if (m.missing.includes('VID2CONTEXT_KEYLESS')) return 'keyless lanes are off (VID2CONTEXT_KEYLESS=0)';
  if (m.missing.length) return `needs ${m.missing.join(', ')}`;
  return 'disabled by its provider settings';
}

export function renderModels(models: ModelInfo[]): string {
  if (!models.length) return '';
  const parts: string[] = [];
  for (const tier of TIERS) {
    const rows = models.filter((m) => m.tier === tier);
    if (!rows.length) continue;
    const on = rows.filter((m) => m.enabled).length;
    parts.push(`${tier} (${on} of ${rows.length} enabled)`);
    parts.push(table(rows.map((m) => [`  ${m.kind}`, m.id, m.enabled ? 'enabled' : 'disabled', why(m)])));
    parts.push('');
  }
  return `${parts.join('\n')}`;
}

export async function modelsCommand(c: CommandContext): Promise<number> {
  const kind = choice(c.values, 'kind', MODEL_KINDS);
  const models = listModels(c.deps.registry, c.deps.ctx.env, kind);
  if (c.json) c.out.text(`${JSON.stringify(models, null, 2)}\n`);
  else c.out.text(renderModels(models));
  if (!models.length) c.note(`No ${kind ?? ''} rungs are installed.`.replace('  ', ' '));
  return 0;
}
