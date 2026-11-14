/**
 * Turn a model choice from a UI or API request into chain options.
 *
 *   nothing                       Auto: the env policy (VID2CONTEXT_POLICY), free-first by default
 *   { policy }                    that policy over the whole chain
 *   { rung }                      start with that rung, then fall back along the chain
 *   { rung, strict: true }        that rung or an error
 */
import { Vid2ContextError } from '../errors.ts';
import type { Registry } from '../registry.ts';
import type { Env, Policy } from '../types.ts';
import { modelEnabled } from './models.ts';
import type { StreamChainOptions } from './stream.ts';

export type ModelChoice = { rung: string; strict?: boolean } | { policy: Policy };

const POLICIES: Policy[] = ['free', 'quality', 'local-only'];

/**
 * Resolve a choice against the registry's llm rungs. Unknown rung ids, an
 * unknown policy, and a strict choice of a rung that is not enabled raise
 * `bad-request`. A non-strict choice of a disabled rung is kept: the chain
 * records it as not eligible and falls back.
 */
export function resolveModelChoice(choice: ModelChoice | undefined, registry: Registry, env: Env): StreamChainOptions {
  if (!choice) return {};
  if ('policy' in choice) {
    if (!POLICIES.includes(choice.policy)) {
      throw new Vid2ContextError('bad-request', `Unknown policy "${String(choice.policy).slice(0, 50)}".`, {
        hint: `Use one of: ${POLICIES.join(', ')}, or omit the model for Auto.`,
      });
    }
    return { policy: choice.policy };
  }
  const id = typeof choice.rung === 'string' ? choice.rung : '';
  const rung = registry.llmRungs(env).find((r) => r.id === id);
  if (!rung) {
    throw new Vid2ContextError('bad-request', `Unknown model "${id.slice(0, 200)}".`, {
      hint: 'Call GET /api/v1/models?kind=llm and pass one of the returned ids as model.rung, or omit the model for Auto.',
    });
  }
  if (choice.strict) {
    if (!modelEnabled(rung, env)) {
      const needs = rung.requires.length > 0 ? `Set ${rung.requires.join(', ')} to enable it` : 'Enable it in the server config';
      throw new Vid2ContextError('bad-request', `Model "${id}" is not enabled on this server.`, {
        hint: `${needs}, pick an enabled model from GET /api/v1/models, or send strict: false to fall back.`,
      });
    }
    return { only: [rung.id] };
  }
  return { prefer: [rung.id] };
}
