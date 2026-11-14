/**
 * listCaptionLanguages(): which transcripts a video offers before fetching
 * any. Tracks come from every captions provider that supports the video
 * (`listTracks`). For YouTube, the languages YouTube can machine-translate a
 * track into come from `translationLanguages` in the innertube player
 * response, read here because the YouTube provider does not export a reader.
 */
import {
  type CaptionTrackInfo,
  type Ctx,
  errorFromResponse,
  fetchWithTimeout,
  Vid2ContextError,
  type VideoRef,
} from '@vid2context/core';
import type { ResearchDeps } from './deps.ts';

export const YOUTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const DEFAULT_ANDROID_VERSION = '20.10.38';

export interface TranslationTarget {
  language: string;
  name: string;
}

interface LanguageName {
  simpleText?: string;
  runs?: { text?: string }[];
}

interface PlayerCaptions {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      translationLanguages?: { languageCode?: string; languageName?: LanguageName }[];
    };
  };
}

/** YouTube's machine-translation targets from a player response. Empty when the video has no translatable track. */
export function readTranslationLanguages(player: unknown): TranslationTarget[] {
  const list = (player as PlayerCaptions | null)?.captions?.playerCaptionsTracklistRenderer?.translationLanguages ?? [];
  const out: TranslationTarget[] = [];
  for (const t of list) {
    if (!t.languageCode) continue;
    const name = t.languageName?.simpleText ?? t.languageName?.runs?.map((r) => r.text ?? '').join('') ?? '';
    out.push({ language: t.languageCode, name: name || t.languageCode });
  }
  return out;
}

/**
 * The same innertube player request the YouTube provider makes (ANDROID
 * client, no key, version overridable with YOUTUBE_ANDROID_VERSION).
 */
export async function fetchYouTubePlayer(videoId: string, ctx: Ctx): Promise<unknown> {
  const version = ctx.env.YOUTUBE_ANDROID_VERSION || DEFAULT_ANDROID_VERSION;
  const res = await fetchWithTimeout(ctx, YOUTUBE_PLAYER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': `com.google.android.youtube/${version} (Linux; U; Android 11) gzip`,
      'x-youtube-client-name': '3',
      'x-youtube-client-version': version,
    },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: version, androidSdkVersion: 30, hl: 'en' } },
      videoId,
    }),
  });
  if (!res.ok) {
    if (res.status === 429) {
      throw new Vid2ContextError('blocked', `YouTube player ${videoId}: HTTP 429`, {
        status: 429,
        hint: 'YouTube is refusing requests from this IP address, which is common on cloud servers. Run vid2context on your own machine or retry later.',
      });
    }
    throw await errorFromResponse(res, `YouTube player ${videoId}`);
  }
  return res.json();
}

/**
 * A Ctx whose fetch answers repeated innertube player requests for the same
 * video from one network call, so the provider's listTracks and the
 * translation reader share a single request.
 */
export function sharePlayerRequests(ctx: Ctx): Ctx {
  const cache = new Map<string, Promise<Response>>();
  const shared = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    if (href !== YOUTUBE_PLAYER_URL || !body) return ctx.fetch(input, init);
    let key: string;
    try {
      const parsed = JSON.parse(body) as { videoId?: string; context?: { client?: { clientName?: string } } };
      key = `${parsed.context?.client?.clientName ?? ''}:${parsed.videoId ?? ''}`;
    } catch {
      return ctx.fetch(input, init);
    }
    let pending = cache.get(key);
    if (!pending) {
      pending = ctx.fetch(input, init);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending.then((r) => r.clone());
  };
  return { ...ctx, fetch: shared as typeof fetch };
}

export interface CaptionLanguages {
  videoId: string;
  url?: string;
  /** Every track a captions provider offers, with the provider that offers it. */
  tracks: (CaptionTrackInfo & { provider: string })[];
  /** Languages the platform can machine-translate a track into (YouTube only). */
  translationTargets: TranslationTarget[];
  notes: string[];
}

/** List caption tracks and translation targets for one video. */
export async function listCaptionLanguages(url: string, deps: ResearchDeps): Promise<CaptionLanguages> {
  const { ref } = deps.registry.resolve(url);
  if (ref.kind !== 'video') {
    throw new Vid2ContextError('unsupported-input', `"${url}" is a ${ref.kind}, not a single video.`, {
      hint: 'Pass one video URL; list the items of a playlist first.',
    });
  }
  const ctx = sharePlayerRequests(deps.ctx);
  const notes: string[] = [];
  const tracks: CaptionLanguages['tracks'] = [];
  const providers = deps.registry.captions().filter((p) => p.supports(ref) && p.listTracks);
  for (const p of providers) {
    const list = (await p.listTracks?.(ref, ctx)) ?? [];
    for (const t of list) tracks.push({ ...t, provider: p.id });
  }
  if (providers.length === 0)
    notes.push(`No installed captions provider lists tracks for ${ref.platform}; the transcript would come from speech-to-text.`);
  else if (tracks.length === 0) notes.push('This video has no caption tracks; the transcript would come from speech-to-text.');

  const translationTargets = await translationTargetsFor(ref, ctx, tracks);
  if (ref.platform === 'youtube' && tracks.length > 0 && translationTargets.length === 0) {
    notes.push('YouTube offers no machine translation for these tracks.');
  }
  return { videoId: ref.id, ...(ref.url ? { url: ref.url } : {}), tracks, translationTargets, notes };
}

async function translationTargetsFor(ref: VideoRef, ctx: Ctx, tracks: CaptionTrackInfo[]): Promise<TranslationTarget[]> {
  if (ref.platform !== 'youtube' || tracks.length === 0) return [];
  return readTranslationLanguages(await fetchYouTubePlayer(ref.nativeId, ctx));
}
