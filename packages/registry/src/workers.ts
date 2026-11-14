import { type Ctx, createContext, type Env, Registry } from '@vid2context/core';
import { providerPackages, providers } from './generated/workers.ts';

export { providerPackages, providers };

/** Registry of every provider package that supports the workers runtime. */
export function createRegistry(): Registry {
  return new Registry(providers, 'workers');
}

/**
 * Context for Cloudflare Workers: pass the worker's env. String vars and
 * secrets become `ctx.env`; every other value (AI, D1, R2, KV, Vectorize
 * bindings) is passed through untouched as `ctx.bindings`.
 */
export function createWorkersContext(env: Record<string, unknown>, signal?: AbortSignal): Ctx {
  const strings: Env = {};
  const bindings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') strings[k] = v;
    else if (v !== undefined && v !== null) bindings[k] = v;
  }
  return createContext({ runtime: 'workers', env: strings, signal, bindings });
}
