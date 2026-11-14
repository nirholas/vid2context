import { type CaptionsProvider, defineProvider, type Transcript, Vid2ContextError } from '@vid2context/core';
import { playabilityError } from '../resilience/errors.ts';
import { getPlayer, type PlayerResponse } from '../resilience/player.ts';
import { fetchTrack } from './fetch.ts';
import { choose, trackInfo, tracksOf } from './tracks.ts';

/** Throw when the player response says the video's captions cannot be read now. */
function assertReadable(player: PlayerResponse, videoId: string): void {
  const err = playabilityError(player, videoId);
  if (err && !player.captions) throw err;
  if (player.videoDetails?.isLive && !player.captions) {
    throw new Vid2ContextError('unavailable', `YouTube ${videoId}: the live stream has not ended.`, {
      hint: 'YouTube publishes captions for a live stream after it ends. Try again then.',
    });
  }
}

export const youtubeCaptions: CaptionsProvider = defineProvider({
  id: 'youtube-captions',
  kind: 'captions',
  name: 'YouTube captions',
  runtimes: ['node', 'workers', 'browser'],
  supports: (ref) => ref.platform === 'youtube' && ref.kind === 'video',
  async listTracks(ref, ctx) {
    const player = await getPlayer(ref.nativeId, ctx);
    assertReadable(player, ref.nativeId);
    return tracksOf(player).map(trackInfo);
  },
  async getCaptions(ref, opts, ctx): Promise<Transcript | null> {
    const player = await getPlayer(ref.nativeId, ctx);
    assertReadable(player, ref.nativeId);
    const picked = choose(player, opts);
    if (!picked) return null;
    const segments = await fetchTrack(picked.track, ctx, picked.translateTo, player.client);
    ctx.log.debug('youtube-captions: track', {
      language: picked.track.languageCode,
      origin: picked.origin,
      translateTo: picked.translateTo,
      client: player.client,
    });
    return {
      ref,
      language: picked.translateTo ?? picked.track.languageCode,
      origin: picked.origin,
      producer: 'youtube-captions',
      ...(picked.translateTo ? { translated: true } : {}),
      segments,
      createdAt: new Date().toISOString(),
    };
  },
});
