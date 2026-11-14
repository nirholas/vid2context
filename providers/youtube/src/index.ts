/**
 * YouTube source + captions. Keyless: talks to the innertube player API
 * (ANDROID, then IOS; see resilience/clients.ts) and downloads caption tracks
 * as srv3 XML. Works on Node and Workers; in a browser, YouTube's CORS
 * policy blocks these calls, so the browser build routes through a
 * configured API base instead.
 */
import { defineProvider, type SourceProvider } from '@vid2context/core';
import { listMetadata, listYouTube } from './browse/index.ts';
import { youtubeCaptions } from './captions/provider.ts';
import { getYouTubeComments } from './comments/index.ts';
import { getYouTubeMetadata } from './metadata/index.ts';
import { matchYouTube } from './url.ts';

export { listMetadata, listYouTube } from './browse/index.ts';
export { fetchTrack } from './captions/fetch.ts';
export {
  detectFormat,
  parseJson3,
  parseSrv1,
  parseSrv3,
  parseTimedText,
  parseVtt,
  type TimedTextFormat,
} from './captions/formats.ts';
export { youtubeCaptions } from './captions/provider.ts';
export { chooseTrack, originalLanguage, spokenLanguage, type TrackChoice } from './captions/tracks.ts';
export { type CommentOptions, type CommentSort, getYouTubeComments } from './comments/index.ts';
export {
  type ChapterSource,
  extractLinks,
  fallbackMetadata,
  fetchOEmbed,
  getYouTubeMetadata,
  type OEmbedInfo,
  parseDescriptionChapters,
  parseOEmbed,
  parseWatch,
  toMetadata,
  type WatchInfo,
} from './metadata/index.ts';
export { resetBreaker } from './resilience/breaker.ts';
export { CLIENTS, type ClientSpec, resolveClients } from './resilience/clients.ts';
export { BLOCKED_HINT, classifyPlayability, playabilityError, youtubeHttpError } from './resilience/errors.ts';
export { clearPlayerCache, fetchPlayer, getPlayer, type PlayerResponse, type RawCaptionTrack } from './resilience/player.ts';
export { innertubeRequest } from './resilience/transport.ts';
export { matchYouTube } from './url.ts';

const RUNTIMES: SourceProvider['runtimes'] = ['node', 'workers', 'browser'];

export const youtubeSource: SourceProvider = defineProvider({
  id: 'youtube',
  kind: 'source',
  name: 'YouTube',
  runtimes: RUNTIMES,
  match: matchYouTube,
  async getMetadata(ref, ctx) {
    if (ref.kind !== 'video') return listMetadata(ref, ctx);
    return getYouTubeMetadata(ref, ctx);
  },
  listItems: (ref, ctx, opts) => listYouTube(ref, ctx, opts),
  getComments: (ref, ctx, opts) => getYouTubeComments(ref, ctx, opts),
  // Audio for YouTube comes from a source that downloads media (the yt-dlp provider).
  canProvideAudio: () => false,
});

export default [youtubeSource, youtubeCaptions];
