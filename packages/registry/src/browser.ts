import { type Ctx, createContext, type Env, Registry } from '@vid2context/core';
import { providerPackages, providers } from './generated/browser.ts';

export { providerPackages, providers };

/** Registry of every provider package that supports the browser runtime. */
export function createRegistry(): Registry {
  return new Registry(providers, 'browser');
}

/** Context for the browser: env comes from the user's saved settings (their own keys), never from a bundle. */
export function createBrowserContext(env: Env, signal?: AbortSignal): Ctx {
  return createContext({ runtime: 'browser', env, signal });
}
