/**
 * The pipeline when YouTube blocks this server's IP. A block is about the IP,
 * not the video, so it must not end the run at the metadata stage: later
 * rungs get their turn, and when none produces a transcript the caller gets
 * the block (code `blocked`, with its hint), not a vague `no-transcript`.
 * Real YouTube recordings from providers/youtube/test/fixtures.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetBreaker, youtubeCaptions, youtubeSource } from '@vid2context/provider-youtube';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Attempt, getVideoContext, Registry, Vid2ContextError } from '../src/index.ts';
import { type RecordedResponse, replayFetch, testContext } from '../src/testing.ts';

const root = join(import.meta.dirname, '../../..');
const yt = (name: string) => readFileSync(join(root, 'providers/youtube/test/fixtures', name), 'utf8');
const json = (name: string): RecordedResponse => ({ body: yt(name), headers: { 'content-type': 'application/json' } });
const ZOO = 'jNQXAC9IVRw';
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const NEXT_URL = 'https://www.youtube.com/youtubei/v1/next?prettyPrint=false';
const oembed = (id: string) =>
  `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;

const botPlayer = { method: 'POST', url: PLAYER_URL, response: json('player-android_vr-bot-jNQXAC9IVRw.json') };
const youtube = new Registry([youtubeSource, youtubeCaptions], 'node');
const summary = (attempts: Attempt[]) => attempts.map((a) => [a.id, a.stage, a.outcome]);

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

describe('getVideoContext with a blocked YouTube player', () => {
  it('keeps the fallback metadata step and reports the captions block, not no-transcript', async () => {
    const fetch = replayFetch([
      botPlayer,
      { method: 'POST', url: NEXT_URL, response: json('metadata/next-fallback-jNQXAC9IVRw.json') },
      { url: oembed(ZOO), response: json('metadata/oembed-jNQXAC9IVRw.json') },
      { method: 'HEAD', url: `https://i.ytimg.com/vi/${ZOO}/maxresdefault.jpg`, response: { status: 404, body: '' } },
    ]);
    const ctx = testContext({ fetch });
    const err = await failure(getVideoContext(youtube, `https://www.youtube.com/watch?v=${ZOO}`, { mode: 'captions' }, ctx));
    expect(err.code).toBe('blocked');
    expect(err.hint).toMatch(/home network/);
    expect(summary(err.attempts)).toEqual([
      ['youtube', 'resolve', 'ok'],
      ['youtube', 'metadata', 'ok'],
      ['youtube-captions', 'captions', 'error'],
    ]);
  });

  it('goes on past a blocked metadata step and still ends with the block and every client attempt', async () => {
    const id = 'xxxxxxxxxxx';
    const fetch = replayFetch([
      botPlayer,
      { url: oembed(id), response: { status: 400, body: yt('metadata/oembed-400-xxxxxxxxxxx.txt') } },
    ]);
    const err = await failure(
      getVideoContext(youtube, `https://www.youtube.com/watch?v=${id}`, { mode: 'auto' }, testContext({ fetch })),
    );
    expect(err.code).toBe('blocked');
    expect(err.message).toContain('every client failed');
    expect(summary(err.attempts)).toEqual([
      ['youtube', 'resolve', 'ok'],
      ['youtube/android', 'metadata', 'error'],
      ['youtube/ios', 'metadata', 'error'],
      ['youtube', 'metadata', 'error'],
      // The player breaker opened on the metadata block, so the captions rung did not ask the player again.
      ['youtube-captions', 'captions', 'error'],
      // No source here can download YouTube audio (yt-dlp is not in this registry).
      ['audio', 'audio', 'skipped'],
    ]);
    expect(err.attempts.find((a) => a.id === 'youtube-captions')?.detail).toMatch(/paused/);
  });
});
