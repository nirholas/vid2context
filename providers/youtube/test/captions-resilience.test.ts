import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Attempt, createContext, type Env, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type RecordedCall, type RecordedResponse, replayFetch, testContext } from '@vid2context/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { youtubeCaptions } from '../src/captions/provider.ts';
import { chooseTrack } from '../src/captions/tracks.ts';
import { youtubeSource } from '../src/index.ts';
import { backoffDelayMs, isRetryable, MAX_RETRIES } from '../src/resilience/backoff.ts';
import { breakerRemainingSec, resetBreaker } from '../src/resilience/breaker.ts';
import { CLIENTS, resolveClients } from '../src/resilience/clients.ts';
import { BLOCKED_HINT, classifyPlayability, playabilityError, youtubeHttpError } from '../src/resilience/errors.ts';
import { clearPlayerCache, fetchPlayer, getPlayer, type PlayerResponse } from '../src/resilience/player.ts';
import { innertubeRequest } from '../src/resilience/transport.ts';
import { matchYouTube } from '../src/url.ts';

// Every response below is a real recording (see test/fixtures/README.md, "Captions and blocks").
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const json = (name: string): RecordedResponse => ({ body: fixture(name), headers: { 'content-type': 'application/json' } });
const player = (name: string) => JSON.parse(fixture(name)) as PlayerResponse;
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const ZOO = 'jNQXAC9IVRw';

const ref = (input: string): VideoRef => {
  const r = matchYouTube(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
};

/** Serve a player response chosen by the innertube client that asked (x-youtube-client-name: 3 ANDROID, 5 IOS). */
function byClient(answers: Record<string, RecordedResponse | ((call: RecordedCall) => RecordedResponse)>) {
  return {
    method: 'POST',
    url: PLAYER_URL,
    response: (call: RecordedCall) => {
      const name = call.headers['x-youtube-client-name'] === '5' ? 'IOS' : 'ANDROID';
      const a = answers[name];
      if (!a) throw new Error(`no recorded answer for ${name}`);
      return typeof a === 'function' ? a(call) : a;
    },
  };
}

const zooTimedtext = [
  { url: /timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/, response: { body: fixture('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
  { url: /timedtext\?v=jNQXAC9IVRw.*lang=de.*fmt=srv3/, response: { body: fixture('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
];

const playerCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url === PLAYER_URL);
const clientOf = (c: RecordedCall) =>
  (JSON.parse(String(c.body)) as { context: { client: { clientName: string } } }).context.client.clientName;

beforeEach(() => resetBreaker());
afterEach(() => vi.useRealTimers());

describe('player clients', () => {
  it('tries ANDROID then IOS by default and honours YOUTUBE_CLIENTS and version overrides', () => {
    expect(resolveClients({}).map((c) => c.key)).toEqual(['android', 'ios']);
    expect(CLIENTS.map((c) => c.clientName)).toEqual(['ANDROID', 'IOS']);
    const env: Env = { YOUTUBE_CLIENTS: ' IOS, android ,ios', YOUTUBE_IOS_VERSION: '21.01.1' };
    expect(resolveClients(env).map((c) => [c.key, c.version])).toEqual([
      ['ios', '21.01.1'],
      ['android', '20.10.38'],
    ]);
  });

  it('rejects unknown client names with a hint listing the valid ones', () => {
    expect(() => resolveClients({ YOUTUBE_CLIENTS: 'android,web' })).toThrow(Vid2ContextError);
    try {
      resolveClients({ YOUTUBE_CLIENTS: 'android,web' });
    } catch (err) {
      expect(err).toMatchObject({ code: 'bad-request', hint: 'Use a comma-separated list of: android, ios.' });
    }
  });

  it('falls back to IOS when ANDROID gets the bot check, without opening the breaker', async () => {
    const fetch = replayFetch([
      byClient({ ANDROID: json('player-android_vr-bot-jNQXAC9IVRw.json'), IOS: json('player-ios-jNQXAC9IVRw.json') }),
      ...zooTimedtext,
    ]);
    const ctx = testContext({ fetch });
    const t = await youtubeCaptions.getCaptions(ref(ZOO), { language: 'de' }, ctx);
    expect(t).toMatchObject({ language: 'de', origin: 'creator-captions' });
    expect(playerCalls(fetch.calls).map(clientOf)).toEqual(['ANDROID', 'IOS']);
    const p = await getPlayer(ZOO, ctx);
    expect(p.client).toBe('IOS');
    expect(p.attempts?.map((a) => [a.id, a.outcome, a.reason])).toEqual([
      ['youtube/android', 'error', 'bot-check'],
      ['youtube/ios', 'ok', undefined],
    ]);
    expect(breakerRemainingSec()).toBe(0);
  });

  it('falls back when YouTube rejects a retired client version with HTTP 400', async () => {
    const fetch = replayFetch([
      byClient({
        ANDROID: { status: 400, ...json('player-android-old-version-400.json') },
        IOS: json('player-ios-jNQXAC9IVRw.json'),
      }),
    ]);
    const ctx = testContext({ fetch, env: { YOUTUBE_ANDROID_VERSION: '19.09.37' } });
    const p = await fetchPlayer(ZOO, ctx);
    expect(p.client).toBe('IOS');
    expect(fetch.calls[0]?.headers['x-youtube-client-version']).toBe('19.09.37');
    expect(p.attempts?.[0]).toMatchObject({ id: 'youtube/android', outcome: 'error', reason: 'upstream' });
  });

  it('uses the next client when the first has no captions, and accepts a video that has none on any client', async () => {
    const fetch = replayFetch([
      byClient({
        ANDROID: json('player-nocaptions-android-brXcsLhw84o.json'),
        IOS: json('player-nocaptions-ios-brXcsLhw84o.json'),
      }),
    ]);
    const ctx = testContext({ fetch });
    expect(await youtubeCaptions.getCaptions(ref('brXcsLhw84o'), {}, ctx)).toBeNull();
    const p = await getPlayer('brXcsLhw84o', ctx);
    expect(p.client).toBe('ANDROID');
    expect(p.attempts?.map((a) => a.reason)).toEqual(['no-captions', 'no-captions']);
    expect((await youtubeSource.getMetadata(ref('brXcsLhw84o'), ctx)).title).toContain('Piano');
    expect(playerCalls(fetch.calls)).toHaveLength(2);
  });

  it('keeps a playable answer without captions when the next client hits the block page', async () => {
    const fetch = replayFetch([
      byClient({
        ANDROID: json('player-nocaptions-android-brXcsLhw84o.json'),
        IOS: { status: 429, body: fixture('timedtext-429-blocked.html') },
      }),
    ]);
    const p = await fetchPlayer('brXcsLhw84o', testContext({ fetch }));
    expect(p.client).toBe('ANDROID');
    expect(p.attempts?.map((a) => a.reason)).toEqual(['no-captions', 'blocked']);
    expect(breakerRemainingSec()).toBe(600);
  });

  it('stops at a verdict about the video instead of asking more clients', async () => {
    const fetch = replayFetch([byClient({ ANDROID: json('player-private-yZIXLfi8CZQ.json') })]);
    const ctx = testContext({ fetch });
    await expect(youtubeCaptions.getCaptions(ref('yZIXLfi8CZQ'), {}, ctx)).rejects.toMatchObject({ code: 'not-found' });
    expect(playerCalls(fetch.calls)).toHaveLength(1);
  });

  it('reports every client when all are refused for client reasons', async () => {
    const fetch = replayFetch([
      byClient({
        ANDROID: json('player-tv_embedded-unsupported-jNQXAC9IVRw.json'),
        IOS: json('player-web-reload-jNQXAC9IVRw.json'),
      }),
    ]);
    const err = await fetchPlayer(ZOO, testContext({ fetch })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    const e = err as Vid2ContextError & { attempts: Attempt[] };
    expect(e.code).toBe('unavailable');
    expect(e.message).toContain('every client failed');
    expect(e.message).toContain('no longer supported');
    expect(e.message).toContain('The page needs to be reloaded.');
    expect(e.hint).toContain('YOUTUBE_CLIENTS');
    expect(e.attempts.map((a) => a.reason)).toEqual(['client-refused', 'client-refused']);
    expect(breakerRemainingSec()).toBe(0);
  });

  it('caches the player response per video for 60 seconds across contexts sharing an env', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetch = replayFetch([byClient({ ANDROID: json('player-jNQXAC9IVRw.json') })]);
    const env: Env = {};
    const a = createContext({ runtime: 'node', env, fetch, log: testContext().log });
    const b = createContext({ runtime: 'node', env, fetch, log: testContext().log });
    await getPlayer(ZOO, a);
    await getPlayer(ZOO, b);
    expect(playerCalls(fetch.calls)).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    await getPlayer(ZOO, b);
    expect(playerCalls(fetch.calls)).toHaveLength(2);
    await getPlayer(ZOO, testContext({ fetch }));
    expect(playerCalls(fetch.calls)).toHaveLength(3);
  });
});

describe('error taxonomy (real playability responses)', () => {
  it.each([
    ['player-unavailable.json', 'xxxxxxxxxxx', 'not-found', /removed|does not exist/],
    ['player-removed-6SJNVb0GnPI.json', '6SJNVb0GnPI', 'not-found', /removed/],
    ['player-private-yZIXLfi8CZQ.json', 'yZIXLfi8CZQ', 'not-found', /private/],
    ['player-age-restricted-HtVdAasjOgU.json', 'HtVdAasjOgU', 'unavailable', /age-restricted.*YOUTUBE_COOKIE/],
    ['player-members-only-Pw0wchRQJac.json', 'Pw0wchRQJac', 'unavailable', /members only/],
    ['player-upcoming-w8DxIwCbsVc.json', 'w8DxIwCbsVc', 'unavailable', /scheduled for 2026-11-15T04:30:00\.000Z/],
    ['player-android_vr-bot-jNQXAC9IVRw.json', ZOO, 'blocked', /home network/],
  ])('%s -> %s', (file, id, code, hint) => {
    const err = playabilityError(player(file), id);
    expect(err?.code).toBe(code);
    expect(err?.hint).toMatch(hint);
  });

  it('separates client refusals and bot checks from verdicts about the video', () => {
    const kind = (file: string) => classifyPlayability(player(file).playabilityStatus, ZOO).kind;
    expect(kind('player-tv_embedded-unsupported-jNQXAC9IVRw.json')).toBe('client');
    expect(kind('player-web-reload-jNQXAC9IVRw.json')).toBe('client');
    expect(kind('player-mweb-reload-jNQXAC9IVRw.json')).toBe('client');
    expect(kind('player-android_vr-bot-jNQXAC9IVRw.json')).toBe('bot');
    expect(kind('player-members-only-Pw0wchRQJac.json')).toBe('final');
    expect(kind('player-ios-jNQXAC9IVRw.json')).toBe('ok');
  });

  it('surfaces the errors through the providers', async () => {
    const files: Record<string, string> = {
      HtVdAasjOgU: 'player-age-restricted-HtVdAasjOgU.json',
      Pw0wchRQJac: 'player-members-only-Pw0wchRQJac.json',
      w8DxIwCbsVc: 'player-upcoming-w8DxIwCbsVc.json',
      '6SJNVb0GnPI': 'player-removed-6SJNVb0GnPI.json',
      '0U8ykcdZL2g': 'player-live-0U8ykcdZL2g.json',
    };
    const fetch = replayFetch([
      {
        method: 'POST',
        url: PLAYER_URL,
        response: (call) => json(files[(JSON.parse(String(call.body)) as { videoId: string }).videoId] ?? 'missing'),
      },
    ]);
    const ctx = testContext({ fetch });
    await expect(youtubeCaptions.getCaptions(ref('HtVdAasjOgU'), {}, ctx)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(youtubeCaptions.listTracks?.(ref('Pw0wchRQJac'), ctx)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(youtubeCaptions.getCaptions(ref('w8DxIwCbsVc'), {}, ctx)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(youtubeCaptions.getCaptions(ref('6SJNVb0GnPI'), {}, ctx)).rejects.toMatchObject({ code: 'not-found' });
    await expect(youtubeCaptions.getCaptions(ref('0U8ykcdZL2g'), {}, ctx)).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('live stream has not ended'),
    });
    // Final verdicts come from the first client; nothing asked IOS.
    expect(
      playerCalls(fetch.calls)
        .map(clientOf)
        .every((c) => c === 'ANDROID'),
    ).toBe(true);
  });

  it('maps HTTP failures: the 429 block page to blocked, a 400 to upstream with a hint', async () => {
    const blocked = await youtubeHttpError(new Response(fixture('timedtext-429-blocked.html'), { status: 429 }), 'captions');
    expect(blocked).toMatchObject({ code: 'blocked', status: 429, hint: BLOCKED_HINT });
    const bad = await youtubeHttpError(new Response(fixture('player-android-old-version-400.json'), { status: 400 }), 'player');
    expect(bad.code).toBe('upstream');
    expect(bad.message).toContain('Precondition check failed');
    expect(bad.hint).toBeTruthy();
  });
});

describe('circuit breaker', () => {
  const blockedReplay = () =>
    replayFetch([
      byClient({ ANDROID: json('player-cCPsdFdlshc.json') }),
      { url: /timedtext\?v=cCPsdFdlshc/, response: { status: 429, body: fixture('timedtext-429-blocked.html') } },
    ]);

  it('opens on the real 429 block page, fails fast without network, and closes after the cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetch = blockedReplay();
    const ctx = testContext({ fetch });
    await expect(youtubeCaptions.getCaptions(ref('cCPsdFdlshc'), {}, ctx)).rejects.toMatchObject({
      code: 'blocked',
      status: 429,
    });
    // Not retried: one timedtext request.
    expect(fetch.calls.filter((c) => c.url.includes('timedtext'))).toHaveLength(1);
    expect(breakerRemainingSec()).toBe(600);
    expect(breakerRemainingSec('direct', 'timedtext')).toBe(600);
    expect(breakerRemainingSec('direct', 'player')).toBe(0);

    // Another caption download fails fast without touching the network, and says which requests are paused.
    clearPlayerCache(ctx);
    const before = fetch.calls.filter((c) => c.url.includes('timedtext')).length;
    const err = (await youtubeCaptions.getCaptions(ref('cCPsdFdlshc'), {}, ctx).catch((e: unknown) => e)) as Vid2ContextError & {
      attempts: Attempt[];
    };
    expect(err).toMatchObject({ code: 'blocked', hint: BLOCKED_HINT });
    expect(err.message).toMatch(/^YouTube caption downloads are paused for 600s more: .* this request was not sent/);
    expect(err.attempts.some((a) => a.reason === 'circuit-open' && a.outcome === 'skipped')).toBe(true);
    expect(fetch.calls.filter((c) => c.url.includes('timedtext')).length).toBe(before);

    // A caption block says nothing about the player: it still answers, so metadata keeps working.
    const players = replayFetch([byClient({ ANDROID: json('player-jNQXAC9IVRw.json') })]);
    expect((await fetchPlayer(ZOO, testContext({ fetch: players }))).client).toBe('ANDROID');

    vi.advanceTimersByTime(600_000);
    expect(breakerRemainingSec()).toBe(0);
  });

  it('pauses only the player after a bot check on every client, not next or oEmbed', async () => {
    const fetch = replayFetch([
      byClient({ ANDROID: json('player-android_vr-bot-jNQXAC9IVRw.json'), IOS: json('player-android_vr-bot-jNQXAC9IVRw.json') }),
    ]);
    await expect(fetchPlayer(ZOO, testContext({ fetch }))).rejects.toMatchObject({ code: 'blocked' });
    expect(breakerRemainingSec('direct', 'player')).toBe(600);
    expect(breakerRemainingSec('direct', 'web')).toBe(0);
    expect(breakerRemainingSec('direct', 'timedtext')).toBe(0);
    // The next player call is not sent, and its error names this request, not the earlier video.
    const err = (await fetchPlayer('cCPsdFdlshc', testContext({ fetch })).catch((e: unknown) => e)) as Vid2ContextError;
    expect(err.message).toMatch(
      /^YouTube player requests are paused for 600s more: YouTube blocked this IP address \d+s ago, so this request was not sent\. The blocked request: YouTube player jNQXAC9IVRw/,
    );
  });

  it('opens when every client gets the bot check, and honours YOUTUBE_BLOCK_COOLDOWN_SEC', async () => {
    const fetch = replayFetch([
      byClient({ ANDROID: json('player-android_vr-bot-jNQXAC9IVRw.json'), IOS: json('player-android_vr-bot-jNQXAC9IVRw.json') }),
    ]);
    const ctx = testContext({ fetch, env: { YOUTUBE_BLOCK_COOLDOWN_SEC: '30' } });
    await expect(youtubeSource.getMetadata(ref(ZOO), ctx)).rejects.toMatchObject({ code: 'blocked', hint: BLOCKED_HINT });
    expect(breakerRemainingSec()).toBe(30);
  });

  it('can be switched off with a cooldown of 0', async () => {
    const ctx = testContext({ fetch: blockedReplay(), env: { YOUTUBE_BLOCK_COOLDOWN_SEC: '0' } });
    await expect(youtubeCaptions.getCaptions(ref('cCPsdFdlshc'), {}, ctx)).rejects.toMatchObject({ code: 'blocked' });
    expect(breakerRemainingSec()).toBe(0);
  });
});

describe('backoff', () => {
  it('waits a random time up to an exponentially growing cap, or exactly Retry-After', () => {
    const max = () => 0.999999;
    expect([0, 1, 2, 3, 4].map((n) => backoffDelayMs(n, undefined, max))).toEqual([999, 1999, 3999, 7999, 7999]);
    expect(backoffDelayMs(2, undefined, () => 0)).toBe(0);
    expect(backoffDelayMs(0, 5, max)).toBe(5000);
    expect(MAX_RETRIES).toBe(3);
  });

  it('retries rate limits and 5xx but never a block', async () => {
    const blocked = await youtubeHttpError(new Response(fixture('timedtext-429-blocked.html'), { status: 429 }), 'captions');
    expect(isRetryable(blocked)).toBe(false);
    const bad = await youtubeHttpError(new Response(fixture('player-android-old-version-400.json'), { status: 400 }), 'player');
    expect(isRetryable(bad)).toBe(false);
    expect(isRetryable(new Vid2ContextError('rate-limited', 'YouTube: HTTP 429', { status: 429 }))).toBe(true);
    expect(isRetryable(new Vid2ContextError('upstream', 'YouTube: HTTP 503', { status: 503 }))).toBe(true);
  });
});

describe('track choice (real track lists)', () => {
  const zoo = player('player-jNQXAC9IVRw.json').captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const gwPlayer = player('player-cCPsdFdlshc.json');
  const gw = gwPlayer.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const gwTargets = (gwPlayer.captions?.playerCaptionsTracklistRenderer?.translationLanguages ?? []).map((l) => l.languageCode);

  it('requested language: creator, then auto, then a translation into a listed target', () => {
    expect(chooseTrack(zoo, { language: 'de' }, 0)).toMatchObject({ origin: 'creator-captions', track: { languageCode: 'de' } });
    expect(chooseTrack(gw, { language: 'en' }, undefined, gwTargets)).toMatchObject({ origin: 'auto-captions' });
    expect(chooseTrack(zoo, { language: 'fr' }, 0)).toMatchObject({ translateTo: 'fr', track: { languageCode: 'en' } });
    expect(chooseTrack(gw, { language: 'zh-Hant' }, undefined, gwTargets)).toMatchObject({ translateTo: 'zh-Hant' });
    expect(chooseTrack(gw, { language: 'pt-BR' }, undefined, gwTargets)).toMatchObject({ translateTo: 'pt' });
    expect(chooseTrack(gw, { language: 'sw' }, undefined, gwTargets)).toBeNull();
  });

  it('respects allowTranslated and allowAuto', () => {
    expect(chooseTrack(zoo, { language: 'fr', allowTranslated: false }, 0)).toBeNull();
    expect(chooseTrack(gw, { language: 'en', allowAuto: false }, undefined, gwTargets)).toBeNull();
    expect(chooseTrack(gw, { language: 'fr', allowAuto: false }, undefined, gwTargets)).toBeNull();
  });

  it('no language: the default creator track first, auto-captions last', () => {
    expect(chooseTrack(zoo, {}, 1)?.track.languageCode).toBe('de');
    expect(chooseTrack(zoo, {})?.track.languageCode).toBe('en');
    expect(chooseTrack(gw, {})).toMatchObject({ origin: 'auto-captions', track: { languageCode: 'en' } });
  });
});

describe('optional credentials', () => {
  it('sends cookie, SAPISIDHASH, visitorData and PO token, and keeps them out of logs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
    const fetch = replayFetch([byClient({ ANDROID: json('player-jNQXAC9IVRw.json') }), ...zooTimedtext]);
    const logged: string[] = [];
    const log = {
      debug: (m: string, d?: object) => logged.push(m + JSON.stringify(d ?? {})),
      info: (m: string, d?: object) => logged.push(m + JSON.stringify(d ?? {})),
      warn: (m: string, d?: object) => logged.push(m + JSON.stringify(d ?? {})),
      error: (m: string, d?: object) => logged.push(m + JSON.stringify(d ?? {})),
    };
    const env: Env = {
      YOUTUBE_COOKIE: 'PREF=hl=en; SAPISID=cookie-from-test-env',
      YOUTUBE_VISITOR_DATA: 'visitor-from-test-env',
      YOUTUBE_PO_TOKEN: 'po-token-from-test-env',
    };
    const ctx = createContext({ runtime: 'node', env, fetch, log });
    await youtubeCaptions.getCaptions(ref(ZOO), {}, ctx);

    const call = fetch.calls[0] as RecordedCall;
    const ts = Math.floor(Date.parse('2026-11-14T00:00:00Z') / 1000);
    const digest = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(`${ts} cookie-from-test-env https://www.youtube.com`),
    );
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(call.headers.cookie).toBe(env.YOUTUBE_COOKIE);
    expect(call.headers.authorization).toBe(`SAPISIDHASH ${ts}_${hex}`);
    expect(call.headers['x-goog-visitor-id']).toBe('visitor-from-test-env');
    const body = JSON.parse(String(call.body)) as {
      context: { client: { visitorData: string } };
      serviceIntegrityDimensions: { poToken: string };
    };
    expect(body.context.client.visitorData).toBe('visitor-from-test-env');
    expect(body.serviceIntegrityDimensions.poToken).toBe('po-token-from-test-env');

    const caption = new URL(fetch.calls.find((c) => c.url.includes('timedtext'))?.url ?? '');
    expect(caption.searchParams.get('pot')).toBe('po-token-from-test-env');
    expect(caption.searchParams.get('c')).toBe('ANDROID');
    const all = logged.join('\n');
    for (const secret of ['cookie-from-test-env', 'visitor-from-test-env', 'po-token-from-test-env'])
      expect(all).not.toContain(secret);
  });

  it('exposes innertubeRequest with any client spec for the other YouTube endpoints', async () => {
    const fetch = replayFetch([byClient({ IOS: json('player-ios-jNQXAC9IVRw.json') })]);
    const res = await innertubeRequest<PlayerResponse>('player', { videoId: ZOO }, 'ios', testContext({ fetch }));
    expect(res.videoDetails?.title).toBe('Me at the zoo');
    expect(fetch.calls[0]?.headers['user-agent']).toContain('com.google.ios.youtube/20.10.4');
  });
});

describe.skipIf(!process.env.LIVE)('youtube captions (live)', () => {
  const ctx = () => createContext({ runtime: 'node', env: process.env as Env });

  it('reads creator captions in en and de for jNQXAC9IVRw', async () => {
    const en = await youtubeCaptions.getCaptions(ref(ZOO), { language: 'en' }, ctx());
    expect(en?.segments.map((s) => s.text).join(' ')).toContain('elephants');
    const de = await youtubeCaptions.getCaptions(ref(ZOO), { language: 'de' }, ctx());
    expect(de).toMatchObject({ language: 'de', origin: 'creator-captions' });
  });

  it('reads a YouTube translation marked translated', async () => {
    const fr = await youtubeCaptions.getCaptions(ref(ZOO), { language: 'fr' }, ctx());
    expect(fr).toMatchObject({ language: 'fr', translated: true });
    expect(fr?.segments.length).toBeGreaterThan(0);
  });

  it('maps a members-only video to unavailable', async () => {
    await expect(youtubeCaptions.getCaptions(ref('Pw0wchRQJac'), {}, ctx())).rejects.toMatchObject({ code: 'unavailable' });
  });
});
