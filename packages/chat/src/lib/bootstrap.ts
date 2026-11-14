/**
 * Start-up: pick the backend. Server mode when the API at the configured
 * base answers /health (and the build does not force client-only);
 * otherwise client-only mode with the browser registry, loaded on demand so
 * server-mode pages never download provider code.
 */
import { ApiClient } from './api.ts';
import { type Backend, ClientBackend, ServerBackend } from './backend.ts';
import { detectMode } from './settings.ts';
import { type ChatStore, loadProviderKeys, loadServerApiKey } from './store.ts';

export async function createBackend(store: ChatStore, opts: { apiBase: string; fetch?: typeof fetch }): Promise<Backend> {
  const apiKey = await loadServerApiKey().catch(() => '');
  const api = new ApiClient({ base: opts.apiBase, apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const mode = await detectMode(api);
  if (mode === 'server') return new ServerBackend(api, store, await api.routes());
  return createClientBackend(store);
}

export async function createClientBackend(store: ChatStore): Promise<Backend> {
  const env = await loadProviderKeys().catch(() => ({}));
  const { createRegistry } = await import('@vid2context/registry/browser');
  return new ClientBackend(createRegistry(), env, store);
}
