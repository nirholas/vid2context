/**
 * YouTube source + captions. Keyless: talks to the innertube player API with
 * the ANDROID client and downloads caption tracks as srv3 XML. Works on Node
 * and Workers; in a browser, YouTube's CORS policy blocks these calls, so the
 * browser build routes through a configured API base instead.
 */
import { type CaptionsProvider, defineProvider, type SourceProvider, type Transcript } from '@vid2context/core';
import { choose, fetchTrack, tracksOf, trackInfo } from './captions.ts';
import { getPlayer, playabilityError } from './innertube.ts';
import { toMetadata } from './metadata.ts';
import { matchYouTube } from './url.ts';

export { chooseTrack, spokenLanguage } from './captions.ts';
export { parseDescriptionChapters } from './metadata.ts';
export { parseSrv1, parseSrv3, parseTimedText } from './timedtext.ts';
export { matchYouTube } from './url.ts';

const RUNTIMES: SourceProvider['runtimes'] = ['node', 'workers', 'browser'];

export const youtubeSource: SourceProvider = defineProvider({
  id: 'youtube',
  kind: 'source',
  name: 'YouTube',
  runtimes: RUNTIMES,
  match: matchYouTube,
  async getMetadata(ref, ctx) {
    const player = await getPlayer(ref.nativeId, ctx);
    if (!player.videoDetails) {
      throw (
        playabilityError(player, ref.nativeId) ?? playabilityError({ playabilityStatus: { status: 'ERROR' } }, ref.nativeId)
      );
    }
    return toMetadata(ref, player);
  },
  // Audio for YouTube comes from a source that downloads media (the yt-dlp provider).
  canProvideAudio: () => false,
});

export const youtubeCaptions: CaptionsProvider = defineProvider({
  id: 'youtube-captions',
  kind: 'captions',
  name: 'YouTube captions',
  runtimes: RUNTIMES,
  supports: (ref) => ref.platform === 'youtube' && ref.kind === 'video',
  async listTracks(ref, ctx) {
    const player = await getPlayer(ref.nativeId, ctx);
    const err = playabilityError(player, ref.nativeId);
    if (err && !player.captions) throw err;
    return tracksOf(player).map(trackInfo);
  },
  async getCaptions(ref, opts, ctx): Promise<Transcript | null> {
    const player = await getPlayer(ref.nativeId, ctx);
    const err = playabilityError(player, ref.nativeId);
    if (err && !player.captions) throw err;
    const picked = choose(player, opts);
    if (!picked) return null;
    const segments = await fetchTrack(picked.track, ctx, picked.translateTo);
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

export default [youtubeSource, youtubeCaptions];
