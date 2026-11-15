import { type RecordedCall, replayFetch, testContext } from '@vid2context/core/testing';
import { resetBreaker } from '@vid2context/provider-youtube';
import { beforeEach, describe, expect, it } from 'vitest';
import { createServices } from '../src/services.ts';
import { recordedRoutes, testRegistry } from './helpers.ts';

/** Distinct YouTube video ids the batch asked the player endpoint about, in call order. */
function playerIds(calls: RecordedCall[]): string[] {
  const ids = calls
    .filter((c) => /youtubei\/v1\/player/.test(c.url))
    .map((c) => (JSON.parse(String(c.body)) as { videoId: string }).videoId);
  return [...new Set(ids)];
}

function services() {
  return createServices(testRegistry(), () => testContext());
}

beforeEach(() => resetBreaker());

describe('loadBatch', () => {
  it('starts no work when the client is already gone', async () => {
    const fetch = replayFetch(recordedRoutes());
    const controller = new AbortController();
    controller.abort(new DOMException('client disconnected', 'AbortError'));
    const ctx = testContext({ fetch, signal: controller.signal });
    await expect(services().loadBatch({ inputs: ['jNQXAC9IVRw', 'cCPsdFdlshc'] }, {}, ctx)).rejects.toThrow(
      'client disconnected',
    );
    expect(playerIds(fetch.calls)).toEqual([]);
  });

  it('stops handing out videos once one has failed', async () => {
    const fetch = replayFetch(recordedRoutes());
    const ctx = testContext({ fetch });
    // The four workers start the first four inputs together. AAAAAAAAAAA is answered unavailable by the
    // recorded player and fails first; the three real runs take a little longer, and when they finish the
    // queued fifth input must not be started.
    const inputs = ['AAAAAAAAAAA', 'jNQXAC9IVRw', 'cCPsdFdlshc', 'https://youtu.be/jNQXAC9IVRw', 'EEEEEEEEEEE'];
    await expect(services().loadBatch({ inputs }, { comments: false }, ctx)).rejects.toMatchObject({ code: 'not-found' });
    // Give any worker still running time to pick up the next video, as it did before the fix.
    await new Promise((r) => setTimeout(r, 300));
    expect(playerIds(fetch.calls)).not.toContain('EEEEEEEEEEE');
  });

  it('still returns every video in order when all succeed', async () => {
    const fetch = replayFetch(recordedRoutes());
    const out = await services().loadBatch({ inputs: ['jNQXAC9IVRw', 'cCPsdFdlshc'] }, {}, testContext({ fetch }));
    expect(out.map((c) => c.metadata.ref.id)).toEqual(['youtube:jNQXAC9IVRw', 'youtube:cCPsdFdlshc']);
  });
});
