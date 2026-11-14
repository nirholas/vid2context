import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTimedText } from '@vid2context/provider-youtube';
import { buildVideoContext, pickTrack } from '../src/youtube/context.ts';
import { extractPlayerResponse, type WatchPlayerResponse } from '../src/youtube/player.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

export function zooPlayer(): WatchPlayerResponse {
  const p = extractPlayerResponse(fixture('watch-jNQXAC9IVRw.html'), 'jNQXAC9IVRw');
  if (!p) throw new Error('fixture has no player response');
  return p;
}

/** "Me at the zoo" as the extension builds it: recorded watch page plus the recorded en srv3 track. */
export function zooContext() {
  const player = zooPlayer();
  const choice = pickTrack(player);
  if (!choice) throw new Error('fixture has no caption track');
  const segments = parseTimedText(fixture('timedtext-jNQXAC9IVRw-en.srv3.xml'));
  return buildVideoContext({ player, choice, segments, now: new Date('2026-11-14T17:00:00.000Z') });
}
