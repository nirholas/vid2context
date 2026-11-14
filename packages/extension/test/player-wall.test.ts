import { describe, expect, it } from 'vitest';
import { toBridgeError } from '../src/lib/bridge-errors.ts';
import { extractPlayerResponse, playabilityWall, wallError } from '../src/youtube/player.ts';
import { fixture } from './helpers.ts';

describe('playability walls in a watch page', () => {
  // Recorded by the bridge e2e run: YouTube served this to a fresh Chromium profile on its second visit from the VM.
  const bot = fixture('watch-bot-check-jNQXAC9IVRw.html');

  it('finds the bot check, which has no video id', () => {
    expect(extractPlayerResponse(bot, 'jNQXAC9IVRw')).toBeNull();
    expect(playabilityWall(bot)?.playabilityStatus?.status).toBe('LOGIN_REQUIRED');
  });

  it('reports it as blocked, with a way forward for the browser user', () => {
    const wall = playabilityWall(bot);
    if (!wall) throw new Error('no wall');
    const err = wallError(wall, 'jNQXAC9IVRw');
    expect(err.code).toBe('blocked');
    expect(err.message).toContain('not a bot');
    expect(err.hint).toContain('Sign in to YouTube');
    expect(toBridgeError(err).code).toBe('blocked');
  });

  it('sees no wall on a playable page', () => {
    expect(playabilityWall(fixture('watch-jNQXAC9IVRw.html'))).toBeNull();
    expect(playabilityWall(fixture('watch-nocaptions-brXcsLhw84o.html'))).toBeNull();
  });
});
