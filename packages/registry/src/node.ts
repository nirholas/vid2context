import { Registry, createContext, type Ctx, type Env } from '@vid2context/core';
import { providers } from './generated/node.ts';

export { providers };

/** Registry of every provider package that supports the node runtime. */
export function createRegistry(): Registry {
  return new Registry(providers, 'node');
}

/** Context for Node: process.env, global fetch, stderr logging. */
export function createNodeContext(opts: { env?: Env; signal?: AbortSignal } = {}): Ctx {
  return createContext({ runtime: 'node', env: opts.env ?? (process.env as Env), signal: opts.signal });
}
