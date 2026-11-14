import { type Ctx, createContext, type Env, Registry } from '@vid2context/core';
import { providerPackages, providers } from './generated/workers.ts';

export { providerPackages, providers };

/** Registry of every provider package that supports the workers runtime. */
export function createRegistry(): Registry {
  return new Registry(providers, 'workers');
}

/** Context for Cloudflare Workers: pass the worker's env bindings (string vars and secrets). */
export function createWorkersContext(env: Record<string, unknown>, signal?: AbortSignal): Ctx {
  const strings: Env = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') strings[k] = v;
  return createContext({ runtime: 'workers', env: strings, signal });
}
