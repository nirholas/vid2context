/**
 * Vimeo, Loom and Wistia: sources plus the captions or transcripts each
 * platform already publishes, all keyless. Captions providers run before any
 * audio download in the pipeline, so a video with platform captions never
 * costs a speech-to-text call. Audio for speech-to-text comes from a source
 * that downloads media (the yt-dlp provider), so canProvideAudio is false.
 */
import { type CaptionsProvider, defineProvider, type SourceProvider, type Transcript, type VideoRef } from '@vid2context/core';
import { loomCaptions, loomMetadata, loomTracks, matchLoom } from './loom.ts';
import { matchVimeo, trackOrigin, vimeoCaptions, vimeoMetadata, vimeoTracks } from './vimeo.ts';
import { matchWistia, wistiaCaptions, wistiaMetadata, wistiaTracks } from './wistia.ts';

export { apolloState, matchLoom, parseLoomChapters } from './loom.ts';
export { chooseVimeoTrack, matchVimeo, trackOrigin } from './vimeo.ts';
export { parseVtt, vttTime } from './vtt.ts';
export { chooseWistiaCaption, matchWistia, wistiaSegments } from './wistia.ts';

const RUNTIMES: SourceProvider['runtimes'] = ['node', 'workers'];
const isVideo = (platform: string) => (ref: VideoRef) => ref.platform === platform && ref.kind === 'video';

const transcript = (ref: VideoRef, t: Omit<Transcript, 'ref' | 'createdAt'>): Transcript => ({
  ref,
  ...t,
  createdAt: new Date().toISOString(),
});

export const vimeoSource: SourceProvider = defineProvider({
  id: 'vimeo',
  kind: 'source',
  name: 'Vimeo',
  runtimes: RUNTIMES,
  match: matchVimeo,
  getMetadata: vimeoMetadata,
  canProvideAudio: () => false,
});

export const vimeoCaptionsProvider: CaptionsProvider = defineProvider({
  id: 'vimeo-captions',
  kind: 'captions',
  name: 'Vimeo captions',
  runtimes: RUNTIMES,
  supports: isVideo('vimeo'),
  listTracks: vimeoTracks,
  async getCaptions(ref, opts, ctx) {
    const got = await vimeoCaptions(ref, opts, ctx);
    if (!got) return null;
    return transcript(ref, {
      language: got.track.lang.replace(/-x-.*$/i, ''),
      origin: trackOrigin(got.track),
      producer: 'vimeo-captions',
      segments: got.segments,
    });
  },
});

export const loomSource: SourceProvider = defineProvider({
  id: 'loom',
  kind: 'source',
  name: 'Loom',
  runtimes: RUNTIMES,
  match: matchLoom,
  getMetadata: loomMetadata,
  canProvideAudio: () => false,
});

export const loomCaptionsProvider: CaptionsProvider = defineProvider({
  id: 'loom-captions',
  kind: 'captions',
  name: 'Loom captions',
  runtimes: RUNTIMES,
  supports: isVideo('loom'),
  listTracks: loomTracks,
  async getCaptions(ref, opts, ctx) {
    const got = await loomCaptions(ref, opts, ctx);
    if (!got) return null;
    return transcript(ref, {
      language: got.language,
      origin: 'auto-captions',
      producer: 'loom-captions',
      ...(got.service ? { model: got.service } : {}),
      segments: got.segments,
    });
  },
});

export const wistiaSource: SourceProvider = defineProvider({
  id: 'wistia',
  kind: 'source',
  name: 'Wistia',
  runtimes: RUNTIMES,
  match: matchWistia,
  getMetadata: wistiaMetadata,
  canProvideAudio: () => false,
});

export const wistiaCaptionsProvider: CaptionsProvider = defineProvider({
  id: 'wistia-captions',
  kind: 'captions',
  name: 'Wistia captions',
  runtimes: RUNTIMES,
  supports: isVideo('wistia'),
  listTracks: wistiaTracks,
  async getCaptions(ref, opts, ctx) {
    const got = await wistiaCaptions(ref, opts, ctx);
    if (!got) return null;
    return transcript(ref, {
      language: got.language,
      origin: 'creator-captions',
      producer: 'wistia-captions',
      segments: got.segments,
    });
  },
});

export default [vimeoSource, vimeoCaptionsProvider, loomSource, loomCaptionsProvider, wistiaSource, wistiaCaptionsProvider];
