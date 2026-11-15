import { replayFetch, testContext } from '@vid2context/core/testing';
import { resetBreaker } from '@vid2context/provider-youtube';
import { beforeEach, describe, expect, it } from 'vitest';
import { createServices } from '../src/services.ts';
import { calls, recordedRoutes, testRegistry } from './helpers.ts';

const PLAYER = /youtubei\/v1\/player/;

beforeEach(() => resetBreaker());

describe('loadContext single-flight', () => {
  it('runs once for different link forms of the same video arriving together', async () => {
    // Baseline: how many player calls one run makes.
    const once = replayFetch(recordedRoutes());
    await createServices(testRegistry(), () => testContext()).loadContext('jNQXAC9IVRw', {}, testContext({ fetch: once }));
    const perRun = calls(once, PLAYER);
    expect(perRun).toBeGreaterThan(0);

    const fetch = replayFetch(recordedRoutes());
    const services = createServices(testRegistry(), () => testContext());
    const ctx = testContext({ fetch });
    const [a, b, c] = await Promise.all([
      services.loadContext('https://www.youtube.com/watch?v=jNQXAC9IVRw', {}, ctx),
      services.loadContext('https://youtu.be/jNQXAC9IVRw', {}, ctx),
      services.loadContext('  jNQXAC9IVRw ', {}, ctx),
    ]);
    expect(calls(fetch, PLAYER)).toBe(perRun);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('still reports input no source understands', async () => {
    const services = createServices(testRegistry(), () => testContext());
    await expect(services.loadContext('not a video', {}, testContext({ fetch: replayFetch([]) }))).rejects.toMatchObject({
      code: 'unsupported-input',
    });
  });
});
