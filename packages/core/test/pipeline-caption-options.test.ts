/**
 * The pipeline passes `allowAuto` and `allowTranslated` through to captions
 * providers, so a caller can refuse auto-captions or a platform machine
 * translation. Real YouTube recordings from providers/youtube/test/fixtures.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetBreaker, youtubeCaptions, youtubeSource } from '@vid2context/provider-youtube';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Attempt, getVideoContext, Registry, Vid2ContextError } from '../src/index.ts';
import { type RecordedCall, replayFetch, testContext } from '../src/testing.ts';

const root = join(import.meta.dirname, '../../..');
const yt = (name: string) => readFileSync(join(root, 'providers/youtube/test/fixtures', name), 'utf8');
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const youtube = new Registry([youtubeSource, youtubeCaptions], 'node');
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

function replay() {
  return replayFetch([
    {
      method: 'POST',
      url: PLAYER_URL,
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        return { body: yt(`player-${videoId}.json`), headers: { 'content-type': 'application/json' } };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/, response: { body: yt('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    { url: /timedtext\?v=cCPsdFdlshc.*lang=en.*fmt=srv3/, response: { body: yt('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
  ]);
}

const captionAttempts = (attempts: Attempt[]) =>
  attempts.filter((a) => a.stage === 'captions').map((a) => [a.id, a.outcome, a.reason ?? a.detail]);

async function failure(p: Promise<unknown>): Promise<Vid2ContextError & { attempts: Attempt[] }> {
  const err = await p.then(
    () => {
      throw new Error('expected the run to fail');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Vid2ContextError);
  return err as Vid2ContextError & { attempts: Attempt[] };
}

beforeEach(() => resetBreaker());

describe('caption options reach the captions providers', () => {
  it('allowTranslated: false refuses the platform translation into a language the video has no track in', async () => {
    const fetch = replay();
    const err = await failure(
      getVideoContext(
        youtube,
        watch('jNQXAC9IVRw'),
        { mode: 'captions', language: 'fr', allowTranslated: false },
        testContext({ fetch }),
      ),
    );
    expect(err.code).toBe('no-transcript');
    expect(err.hint).toMatch(/refused/);
    expect(captionAttempts(err.attempts)).toEqual([['youtube-captions', 'empty', 'no-tracks']]);
    expect(fetch.calls.some((c) => c.url.includes('timedtext'))).toBe(false);
  });

  it('by default the provider asks the platform for a machine translation (tlang=fr)', async () => {
    const fetch = replay();
    // No recording exists for the French translation, so the replay refuses the request; what matters is that it was made.
    await getVideoContext(youtube, watch('jNQXAC9IVRw'), { mode: 'captions', language: 'fr' }, testContext({ fetch })).catch(
      () => undefined,
    );
    expect(fetch.calls.some((c) => c.url.includes('timedtext') && c.url.includes('tlang=fr'))).toBe(true);
  });

  it('allowAuto: false refuses auto-captions; the default takes them', async () => {
    const err = await failure(
      getVideoContext(youtube, watch('cCPsdFdlshc'), { mode: 'captions', allowAuto: false }, testContext({ fetch: replay() })),
    );
    expect(err.code).toBe('no-transcript');
    expect(captionAttempts(err.attempts)).toEqual([['youtube-captions', 'empty', 'no-tracks']]);

    resetBreaker();
    const ok = await getVideoContext(youtube, watch('cCPsdFdlshc'), { mode: 'captions' }, testContext({ fetch: replay() }));
    expect(ok.transcript.origin).toBe('auto-captions');
  });

  it('creator captions still come through with both options off', async () => {
    const ok = await getVideoContext(
      youtube,
      watch('jNQXAC9IVRw'),
      { mode: 'captions', language: 'en', allowAuto: false, allowTranslated: false },
      testContext({ fetch: replay() }),
    );
    expect(ok.transcript).toMatchObject({ origin: 'creator-captions', language: 'en' });
    expect(ok.transcript.translated).toBeFalsy();
  });
});
