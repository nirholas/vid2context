import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Ctx, createContext, type Env, Registry } from '@vid2context/core';
import { providerPackages, providers } from './generated/node.ts';
import { youtubeProxyFetch } from './proxy.ts';

export { isYouTubeHost, parseProxyList, youtubeProxyFetch } from './proxy.ts';
export { providerPackages, providers };

/** Registry of every provider package that supports the node runtime. */
export function createRegistry(): Registry {
  return new Registry(providers, 'node');
}

/**
 * Context for Node: process.env, global fetch, stderr logging. With
 * YOUTUBE_PROXY set, YouTube requests (and only those) go through the proxy
 * (see proxy.ts); every other request uses the global fetch directly.
 */
export function createNodeContext(opts: { env?: Env; signal?: AbortSignal } = {}): Ctx {
  const env = opts.env ?? (process.env as Env);
  return createContext({ runtime: 'node', env, fetch: youtubeProxyFetch(env), signal: opts.signal });
}

/**
 * Load keys from env files into process.env: VID2CONTEXT_ENV_FILE when set,
 * then ./.env in the current directory. Variables already set in the shell
 * win. Returns the files that were loaded (paths only, never values).
 */
export function loadEnvFiles(cwd: string = process.cwd()): string[] {
  const candidates = [process.env.VID2CONTEXT_ENV_FILE, resolve(cwd, '.env')].filter((p): p is string => Boolean(p));
  const loaded: string[] = [];
  for (const file of [...new Set(candidates.map((p) => resolve(cwd, p)))]) {
    if (!existsSync(file)) continue;
    process.loadEnvFile(file);
    loaded.push(file);
  }
  return loaded;
}
