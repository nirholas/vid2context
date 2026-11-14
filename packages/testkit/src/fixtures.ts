/**
 * Shared real fixtures and small guards used by every suite.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoContext } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';

/** Repository root (packages/testkit/src -> ../../..). */
export const repoRoot = join(import.meta.dirname, '..', '..', '..');

/** Directory of the shared `VideoContext` fixtures. */
export const contextFixturesDir = join(repoRoot, 'tests', 'fixtures', 'contexts');

/** Every real `VideoContext` in tests/fixtures/contexts, sorted by file name. */
export function loadContextFixtures(): { file: string; context: VideoContext }[] {
  return readdirSync(contextFixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, context: JSON.parse(readFileSync(join(contextFixturesDir, file), 'utf8')) as VideoContext }));
}

/** One shared context fixture by file name, e.g. 'youtube-jNQXAC9IVRw.json'. */
export function loadContextFixture(file: string): VideoContext {
  return JSON.parse(readFileSync(join(contextFixturesDir, file), 'utf8')) as VideoContext;
}

/** Thrown by the network guard; suites assert it never fires. */
export class NetworkTouched extends Error {
  constructor(what: string) {
    super(`network was touched: ${what}`);
    this.name = 'NetworkTouched';
  }
}

/**
 * Run `fn` with the global fetch replaced by one that throws, so code that
 * should be offline (match, isEnabled, rungs) is caught reaching for it.
 * Restores the real fetch afterwards, even on error.
 */
export function withoutNetwork<T>(fn: () => T): { value: T; touched: string[] } {
  const touched: string[] = [];
  const real = globalThis.fetch;
  const guard = (input: RequestInfo | URL): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    touched.push(href);
    throw new NetworkTouched(href);
  };
  globalThis.fetch = guard as typeof fetch;
  try {
    return { value: fn(), touched };
  } finally {
    globalThis.fetch = real;
  }
}

/** A test ctx whose fetch rejects every call (replayFetch with no routes). */
export function offlineContext(env: Record<string, string | undefined> = {}) {
  return testContext({ env, fetch: replayFetch([]) });
}

export function isPromiseLike(v: unknown): boolean {
  return typeof (v as { then?: unknown } | null)?.then === 'function';
}

/** Async form of withoutNetwork: the global fetch throws until `fn` settles. Calls through ctx.fetch are unaffected. */
export async function withoutNetworkAsync<T>(fn: () => Promise<T>): Promise<{ value: T; touched: string[] }> {
  const touched: string[] = [];
  const real = globalThis.fetch;
  const guard = (input: RequestInfo | URL): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    touched.push(href);
    return Promise.reject(new NetworkTouched(href));
  };
  globalThis.fetch = guard as typeof fetch;
  try {
    return { value: await fn(), touched };
  } finally {
    globalThis.fetch = real;
  }
}

/** BCP-47 shape: a 2-3 letter primary subtag, then optional subtags. */
export const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/i;
