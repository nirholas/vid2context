import { type Env, type KvStore, MemoryKv, MemoryStorage, Registry } from '@vid2context/core';
import { type RecordedCall, testContext } from '@vid2context/core/testing';
import youtube from '@vid2context/provider-youtube';
import { createLibrary, type LibraryDeps } from '../src/index.ts';
import { captionedVideos, fixtureFetch, loadFixture } from './replay.ts';

export const PLAYLIST = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
export const PLAYLIST_SIZE = 9;
export const GWAGON = 'youtube:cCPsdFdlshc';
export const ZOO = 'youtube:jNQXAC9IVRw';

export interface SetupOptions {
  env?: Env;
  around?: (call: RecordedCall) => Promise<void>;
  storage?: MemoryStorage;
  kv?: KvStore;
  library?: Partial<LibraryDeps>;
}

/**
 * The real pipeline (YouTube provider) on recorded responses, into
 * MemoryStorage. Requests to 127.0.0.1 go to the real local servers tests
 * start (webhook receivers); everything else is replayed, so nothing reaches
 * the network.
 */
export function setup(opts: SetupOptions = {}) {
  const replay = fixtureFetch(loadFixture(), { overrides: captionedVideos, around: opts.around });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1') return globalThis.fetch(input, init);
    return replay(input, init);
  }) as typeof globalThis.fetch;
  // The provider's block breaker would turn one recorded 429 into failures for every later video.
  const ctx = testContext({ env: { YOUTUBE_BLOCK_COOLDOWN_SEC: '0', ...opts.env }, fetch });
  const registry = new Registry(youtube, 'node');
  const storage = opts.storage ?? new MemoryStorage();
  const kv = opts.kv ?? new MemoryKv();
  const lib = createLibrary({ registry, storage, ctx, kv, ...opts.library });
  return { lib, registry, storage, kv, ctx, replay };
}

/** Requests to innertube browse (playlist pages) in a replay's call log. */
export const browseCalls = (replay: { calls: RecordedCall[] }) => replay.calls.filter((c) => c.url.includes('/youtubei/v1/browse'));
