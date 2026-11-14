import { createContext, getVideoContext, MemoryStorage, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { invalidCitations, sourceOf } from '../src/index.ts';
import { chainSampler, connect, GWAGON_ID, resultText, sharedContext, youtubeRegistry, ZOO_ID } from './helpers.ts';

// Two parts of the same G-Wagon buyer's series (Alliance Motorworks), so the digest has something to compare.
const LIVE_VIDEOS = ['https://www.youtube.com/watch?v=cCPsdFdlshc', 'https://www.youtube.com/watch?v=PzJL3aBRas8'];

describe.skipIf(!process.env.LIVE)('digest_videos live: keyless LLM chain as the client model', () => {
  it(
    'digests two real YouTube videos with every citation verified',
    async () => {
      const registry = await youtubeRegistry();
      // An empty env: only the keyless lanes answer, and no key from the shell is used.
      const ctx = createContext({ runtime: 'node', env: {} });
      const storage = new MemoryStorage();

      let urls = LIVE_VIDEOS;
      const contexts: VideoContext[] = [];
      try {
        for (const url of LIVE_VIDEOS) contexts.push(await getVideoContext(registry, url, { storage }, ctx));
      } catch (err) {
        const blocked = err instanceof Vid2ContextError && (err.code === 'blocked' || err.code === 'no-transcript');
        if (!blocked) throw err;
        // YouTube blocks caption downloads from many datacenter IPs; fall back to the shared real contexts.
        console.error(`[live] YouTube refused the captions (${err.code}): using the shared fixture contexts instead`);
        contexts.length = 0;
        for (const id of ['jNQXAC9IVRw', 'cCPsdFdlshc']) {
          const c = sharedContext(id);
          await storage.putContext(c);
          contexts.push(c);
        }
        urls = [ZOO_ID, GWAGON_ID];
      }

      const h = await connect({
        registry,
        ctx,
        storage,
        capabilities: { sampling: {} },
        sampling: chainSampler(registry, ctx, { retries: 8 }),
      });
      try {
        const res = await h.client.callTool(
          {
            name: 'digest_videos',
            arguments: { urls, question: 'Which model years are the best and the worst to buy, and why?' },
          },
          undefined,
          { timeout: 25 * 60 * 1000 },
        );
        const out = resultText(res);
        console.error(`[live] digest_videos result:\n${out}`);
        expect(res.isError).toBeFalsy();
        const cited = out.match(/\]\(https:\/\/www\.youtube\.com\/watch\?v=[\w-]+&t=\d+s\)/g) ?? [];
        expect(cited.length).toBeGreaterThan(0);
        // Everything above the dropped-claims list (which quotes the removed lines verbatim) must validate.
        expect(invalidCitations(out.split('\nDropped claims:')[0] ?? '', contexts.map(sourceOf))).toEqual([]);
      } finally {
        await h.close();
      }
    },
    30 * 60_000,
  );
});
