/**
 * Bilibili source + captions. Keyless: metadata from the public view API,
 * creator and AI subtitles from the subtitle list, and DASH audio (downloaded
 * here with the Referer bilibili's media hosts require) for speech-to-text.
 * Plain fetch with a pure-TypeScript WBI signature, so it runs on Node and
 * Workers. Browsers cannot send the Referer, so there is no browser build.
 * BILIBILI_SESSDATA (optional) adds a logged-in session.
 */
import { type CaptionsProvider, defineProvider, type SourceProvider, type Transcript, Vid2ContextError } from '@vid2context/core';
import { getView, resolvePart } from './api.ts';
import { downloadAudio } from './audio.ts';
import { chooseTrack, fetchTrack, listTracks, trackInfo } from './captions.ts';
import { baseMetadata, enrich, listMetadata, partsOf } from './metadata.ts';
import { matchBilibili, parseRef } from './url.ts';

export { apiError } from './api.ts';
export { chooseTrack, languageOf, toSegments } from './captions.ts';
export { md5Hex } from './md5.ts';
export { av2bv, bv2av, matchBilibili, parseRef } from './url.ts';
export { mixinKey, signQuery } from './wbi.ts';

const RUNTIMES: SourceProvider['runtimes'] = ['node', 'workers'];

export const bilibiliSource: SourceProvider = defineProvider({
  id: 'bilibili',
  kind: 'source',
  name: 'Bilibili',
  runtimes: RUNTIMES,
  match: matchBilibili,
  async getMetadata(ref, ctx) {
    const parsed = parseRef(ref);
    if (parsed && 'page' in parsed && parsed.page === 'all') return listMetadata(ref, await getView(ctx, parsed.bvid));
    const part = await resolvePart(ref, ctx);
    return enrich(baseMetadata(ref, part), part, ctx);
  },
  async *listItems(ref, ctx, opts = {}) {
    const parsed = parseRef(ref);
    if (!parsed) throw new Vid2ContextError('bad-request', `Not a Bilibili ref: ${ref.id}`);
    const bvid = 'short' in parsed ? (await resolvePart(ref, ctx)).bvid : parsed.bvid;
    const parts = partsOf(await getView(ctx, bvid), ref.input);
    for (const [i, item] of parts.entries()) {
      if (opts.limit && i >= opts.limit) return;
      yield item;
    }
  },
  canProvideAudio: (ref) => ref.platform === 'bilibili' && ref.kind === 'video',
  async getAudio(ref, ctx) {
    return downloadAudio(await resolvePart(ref, ctx), ctx);
  },
});

export const bilibiliCaptions: CaptionsProvider = defineProvider({
  id: 'bilibili-captions',
  kind: 'captions',
  name: 'Bilibili subtitles',
  runtimes: RUNTIMES,
  supports: (ref) => ref.platform === 'bilibili' && ref.kind === 'video',
  async listTracks(ref, ctx) {
    return (await listTracks(await resolvePart(ref, ctx), ctx)).map(trackInfo);
  },
  async getCaptions(ref, opts, ctx): Promise<Transcript | null> {
    const part = await resolvePart(ref, ctx);
    const track = chooseTrack(await listTracks(part, ctx), opts);
    if (!track) return null;
    return {
      ref,
      language: track.language,
      origin: track.origin,
      producer: 'bilibili-captions',
      segments: await fetchTrack(track, ctx),
      createdAt: new Date().toISOString(),
    };
  },
});

export default [bilibiliSource, bilibiliCaptions];
