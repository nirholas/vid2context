import type { Ctx, Registry, Storage } from '@vid2context/core';

/**
 * Where saved contexts come from. A Storage instance, a factory that opens
 * one per call (the HTTP server's `storage(ctx)`), or null to skip caching.
 * When omitted, the registry's enabled storage provider is used, if any.
 */
export type StorageSource = Storage | null | ((ctx: Ctx) => Promise<Storage | null>);

export interface ResearchDeps {
  registry: Registry;
  ctx: Ctx;
  storage?: StorageSource;
}

export async function openStorage(deps: ResearchDeps): Promise<Storage | null> {
  const s = deps.storage;
  if (s === undefined) return deps.registry.openStorage(deps.ctx);
  if (typeof s === 'function') return s(deps.ctx);
  return s;
}

/** Map with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
