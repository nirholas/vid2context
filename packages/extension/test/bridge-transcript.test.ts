/**
 * The bridge's two ways to a transcript, on responses recorded from YouTube:
 * the direct path (the YouTube provider's innertube player and timedtext
 * calls, as the background sends them) and the page path the YouTube tab runs.
 * Player and timedtext recordings are the YouTube provider's
 * (providers/youtube/test/fixtures/README.md); the 403 page and the watch
 * pages are this package's (test/fixtures/README.md).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vid2ContextError } from '@vid2context/core';
import { type RecordedCall, type RecordedResponse, replayFetch, testContext } from '@vid2context/core/testing';
import { resetBreaker } from '@vid2context/provider-youtube';
import { beforeEach, describe, expect, it } from 'vitest';
import { bridgeCode, finalError, toBridgeError } from '../src/lib/bridge-errors.ts';
import type { ProgressStage } from '../src/lib/bridge-protocol.ts';
import { type DirectOutcome, fetchDirect } from '../src/youtube/direct.ts';
import { extractPlayerResponse } from '../src/youtube/player.ts';
import { transcriptFromPage } from '../src/youtube/transcript.ts';
import { fixture, zooPlayer } from './helpers.ts';

const providerFixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'providers',
  'youtube',
  'test',
  'fixtures',
);
const yt = (name: string) => readFileSync(join(providerFixtures, name), 'utf8');
const json = (name: string): RecordedResponse => ({ body: yt(name), headers: { 'content-type': 'application/json' } });
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const ZOO = 'jNQXAC9IVRw';

/** A player response by the innertube client that asked (x-youtube-client-name: 3 ANDROID, 5 IOS). */
function player(android: RecordedResponse, ios: RecordedResponse = android) {
  return {
    method: 'POST',
    url: PLAYER_URL,
    response: (call: RecordedCall) => (call.headers['x-youtube-client-name'] === '5' ? ios : android),
  };
}

const zooTracks = [
  { url: /timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/, response: { body: yt('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
  { url: /timedtext\?v=jNQXAC9IVRw.*lang=de.*fmt=srv3/, response: { body: yt('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
];

async function direct(routes: Parameters<typeof replayFetch>[0], videoId: string, language?: string) {
  const fetch = replayFetch(routes);
  const stages: ProgressStage[] = [];
  const outcome = await fetchDirect(
    { videoId, ...(language ? { language } : {}) },
    testContext({ fetch, runtime: 'browser' }),
    (stage) => stages.push(stage),
  );
  return { outcome, stages, calls: fetch.calls };
}

function ok(outcome: DirectOutcome) {
  if (outcome.kind !== 'ok') throw new Error(`expected a transcript, got ${JSON.stringify(outcome)}`);
  return outcome.body;
}

beforeEach(() => resetBreaker());

describe('direct path: transcripts', () => {
  it('reads the creator track in the spoken language, with metadata', async () => {
    const { outcome, stages, calls } = await direct([player(json('player-jNQXAC9IVRw.json')), ...zooTracks], ZOO);
    const body = ok(outcome);
    expect(body.transcript).toMatchObject({ language: 'en', kind: 'creator-captions', name: 'English' });
    expect(body.transcript.translated).toBeUndefined();
    expect(body.transcript.segments).toHaveLength(6);
    expect(body.transcript.segments[0]).toEqual({
      startSec: 1.2,
      endSec: 3.36,
      text: 'All right, so here we are, in front of the elephants',
    });
    expect(body.metadata).toEqual({ title: 'Me at the zoo', channel: 'jawed', durationSec: 19 });
    expect(stages).toEqual(['player', 'captions']);
    // One player call (ANDROID answered with captions), then the caption track.
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/youtubei/v1/player', '/api/timedtext']);
    // The provider still asks for YouTube's Origin; the browser drops it, which is why youtube-origin.ts exists.
    expect(calls[0]?.headers.origin).toBe('https://www.youtube.com');
  });

  it('honours a requested language through chooseTrack', async () => {
    const body = ok((await direct([player(json('player-jNQXAC9IVRw.json')), ...zooTracks], ZOO, 'de')).outcome);
    expect(body.transcript).toMatchObject({ language: 'de', kind: 'creator-captions', name: 'German' });
  });

  it('marks auto-captions', async () => {
    const routes = [
      player(json('player-cCPsdFdlshc.json')),
      { url: /timedtext\?v=cCPsdFdlshc.*lang=en.*fmt=srv3/, response: { body: yt('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
    ];
    const body = ok((await direct(routes, 'cCPsdFdlshc')).outcome);
    expect(body.transcript).toMatchObject({ language: 'en', kind: 'auto-captions', name: 'English (auto-generated)' });
    expect(body.transcript.segments.length).toBeGreaterThan(10);
  });
});

describe('direct path: final answers (the tab would not do better)', () => {
  it('no captions on a playable video', async () => {
    const { outcome } = await direct(
      [player(json('player-nocaptions-android-brXcsLhw84o.json'), json('player-nocaptions-ios-brXcsLhw84o.json'))],
      'brXcsLhw84o',
    );
    expect(outcome).toMatchObject({ kind: 'final', error: { code: 'no-captions' } });
  });

  it('no track and no translation for the requested language', async () => {
    const { outcome, calls } = await direct([player(json('player-cCPsdFdlshc.json'))], 'cCPsdFdlshc', 'sw');
    expect(outcome).toMatchObject({ kind: 'final', error: { code: 'no-captions' } });
    expect(outcome.kind === 'final' && outcome.error.message).toContain('It has: en');
    expect(calls.every((c) => !c.url.includes('timedtext'))).toBe(true);
  });

  it('a removed video', async () => {
    const { outcome } = await direct([player(json('player-removed-6SJNVb0GnPI.json'))], '6SJNVb0GnPI');
    expect(outcome).toMatchObject({ kind: 'final', error: { code: 'not-found' } });
  });

  it('a premiere that has not started and a live stream that has not ended', async () => {
    const upcoming = await direct([player(json('player-upcoming-w8DxIwCbsVc.json'))], 'w8DxIwCbsVc');
    expect(upcoming.outcome).toMatchObject({ kind: 'final', error: { code: 'unavailable' } });
    const live = await direct([player(json('player-live-0U8ykcdZL2g.json'))], '0U8ykcdZL2g');
    expect(live.outcome).toMatchObject({ kind: 'final', error: { code: 'unavailable' } });
  });
});

describe('direct path: refusals hand over to the YouTube tab', () => {
  it('the 403 innertube sends to an extension Origin', async () => {
    const page: RecordedResponse = {
      status: 403,
      body: fixture('player-403-extension-origin.html'),
      headers: { 'content-type': 'text/html' },
    };
    const { outcome, stages } = await direct([player(page)], ZOO);
    expect(outcome).toMatchObject({ kind: 'fallback', reason: { code: 'blocked' } });
    expect(stages).toEqual(['player']);
  });

  it('the bot check on every client', async () => {
    const { outcome } = await direct([player(json('player-android_vr-bot-jNQXAC9IVRw.json'))], ZOO);
    expect(outcome).toMatchObject({ kind: 'fallback', reason: { code: 'blocked' } });
  });

  it('clients that now need a proof-of-origin token ("The page needs to be reloaded")', async () => {
    const { outcome } = await direct([player(json('player-web-reload-jNQXAC9IVRw.json'))], ZOO);
    expect(outcome.kind).toBe('fallback');
  });

  it("login, private and members-only walls, which the user's own session may pass", async () => {
    for (const [file, id] of [
      ['player-private-yZIXLfi8CZQ.json', 'yZIXLfi8CZQ'],
      ['player-members-only-Pw0wchRQJac.json', 'Pw0wchRQJac'],
      ['player-age-restricted-HtVdAasjOgU.json', 'HtVdAasjOgU'],
    ] as const) {
      const { outcome } = await direct([player(json(file))], id);
      expect(outcome.kind, file).toBe('fallback');
    }
  });

  it('the caption track answered with the 429 block page', async () => {
    const routes = [
      player(json('player-cCPsdFdlshc.json')),
      { url: /timedtext\?v=cCPsdFdlshc.*tlang=de/, response: { status: 429, body: yt('timedtext-429-blocked.html') } },
    ];
    const { outcome, stages } = await direct(routes, 'cCPsdFdlshc', 'de');
    expect(stages).toEqual(['player', 'captions']);
    expect(outcome).toMatchObject({ kind: 'fallback', reason: { code: 'blocked' } });
  });
});

describe('page path (the YouTube tab)', () => {
  const noToken = async () => null;

  it('downloads the chosen track from the page and returns the bridge shape', async () => {
    const fetch = replayFetch([
      { url: /\/api\/timedtext\?.*lang=en.*fmt=srv3/, response: { body: fixture('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    ]);
    const body = await transcriptFromPage(zooPlayer(), { videoId: ZOO }, { fetch, getPoToken: noToken });
    expect(body.transcript).toMatchObject({ language: 'en', kind: 'creator-captions', name: 'English' });
    expect(body.transcript.segments).toHaveLength(6);
    expect(body.metadata).toEqual({ title: 'Me at the zoo', channel: 'jawed', durationSec: 19 });
  });

  it('reports the 429 block page as blocked', async () => {
    const fetch = replayFetch([
      { url: /\/api\/timedtext/, response: { status: 429, body: fixture('timedtext-jNQXAC9IVRw-en-429.html') } },
    ]);
    const err = await transcriptFromPage(zooPlayer(), { videoId: ZOO }, { fetch, getPoToken: noToken }).catch((e: unknown) => e);
    expect(toBridgeError(err).code).toBe('blocked');
  });

  it('reports a video without captions as no-captions', async () => {
    const p = extractPlayerResponse(fixture('watch-nocaptions-brXcsLhw84o.html'), 'brXcsLhw84o');
    if (!p) throw new Error('fixture has no player response');
    const err = await transcriptFromPage(p, { videoId: 'brXcsLhw84o' }, { fetch: replayFetch([]), getPoToken: noToken }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(toBridgeError(err).code).toBe('no-captions');
  });
});

describe('error codes', () => {
  it('maps vid2context codes to the contract codes', () => {
    expect(bridgeCode('no-transcript')).toBe('no-captions');
    expect(bridgeCode('auth')).toBe('blocked');
    expect(bridgeCode('rate-limited')).toBe('blocked');
    expect(bridgeCode('upstream')).toBe('unavailable');
    expect(bridgeCode('not-found')).toBe('not-found');
    expect(toBridgeError(new DOMException('took too long', 'TimeoutError'))).toMatchObject({ code: 'timeout' });
    expect(toBridgeError(new Error('boom'))).toMatchObject({ code: 'unavailable', message: 'boom' });
  });

  it('reports the block when the tab only timed out after it', () => {
    const blocked = { code: 'blocked' as const, message: 'HTTP 429.' };
    const tabTimeout = { code: 'timeout' as const, message: 'No captions in 45 seconds.' };
    expect(finalError(tabTimeout, blocked)).toMatchObject({ code: 'blocked', message: expect.stringContaining('45 seconds') });
    const tabNoCaptions = { code: 'no-captions' as const, message: 'None.' };
    expect(finalError(tabNoCaptions, blocked)).toBe(tabNoCaptions);
  });
});
