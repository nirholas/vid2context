/**
 * Wistia, keyless. Every Wistia embed loads two public JSON documents:
 *
 *   https://fast.wistia.com/embed/medias/<hashedId>.json     title, duration, created time, thumbnail
 *   https://fast.wistia.com/embed/captions/<hashedId>.json   every caption track with timed lines
 *
 * Wistia does not say whether a track was typed by a person or generated, nor
 * which language is spoken. Tracks are published by the account owner, so they
 * are reported as creator captions. Without a requested language, a single
 * track is used as is; with several, English is chosen when present, otherwise
 * the first track Wistia lists.
 */
import {
  type CaptionOptions,
  type CaptionTrackInfo,
  type Ctx,
  type Segment,
  Vid2ContextError,
  type VideoMetadata,
  type VideoRef,
} from '@vid2context/core';
import { getText, langMatches, tryJson } from './http.ts';

const ID = /^[a-z0-9]{10}$/;

function videoRef(input: string, id: string): VideoRef {
  return {
    input,
    platform: 'wistia',
    kind: 'video',
    id: `wistia:${id}`,
    nativeId: id,
    url: `https://fast.wistia.net/embed/iframe/${id}`,
  };
}

/**
 * Wistia media URLs:
 *   fast.wistia.net/embed/iframe/<id>, fast.wistia.com/embed/iframe/<id>
 *   fast.wistia.com/embed/medias/<id>[.json|.jsonp]
 *   <account>.wistia.com/medias/<id>, <account>.wi.st/medias/<id>
 */
export function matchWistia(raw: string): VideoRef | null {
  const input = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'fast.wistia.net' || host === 'fast.wistia.com') {
    const [a, b, c] = parts;
    const id = c?.replace(/\.jsonp?$/, '');
    if (a === 'embed' && (b === 'iframe' || b === 'medias') && id && ID.test(id) && parts.length === 3)
      return videoRef(input, id);
    return null;
  }
  const isAccountHost = (host.endsWith('.wistia.com') || host.endsWith('.wi.st')) && host !== 'www.wistia.com';
  const [a, id] = parts;
  if (isAccountHost && a === 'medias' && id && ID.test(id) && parts.length === 2) return videoRef(input, id);
  return null;
}

interface WistiaAsset {
  type?: string;
  url?: string;
  width?: number;
}

export interface WistiaMedia {
  hashedId?: string;
  name?: string;
  duration?: number;
  createdAt?: number;
  type?: string;
  protected?: boolean;
  seoDescription?: string;
  language?: string | null;
  assets?: WistiaAsset[];
}

export interface WistiaCaption {
  bcp47LanguageTag?: string;
  language?: string;
  name?: string;
  familyName?: string;
  hash?: { lines?: { start: number; end: number; text: string[]; extendedAudioDescription?: boolean }[] };
}

async function getMedia(ref: VideoRef, ctx: Ctx): Promise<WistiaMedia> {
  const res = await getText(ctx, `https://fast.wistia.com/embed/medias/${ref.nativeId}.json`);
  if (res.status === 404) throw notFound(ref);
  if (res.status !== 200)
    throw new Vid2ContextError('upstream', `Wistia media ${ref.nativeId}: HTTP ${res.status}`, { status: res.status });
  const data = tryJson<{ media?: WistiaMedia; error?: boolean }>(res.body);
  // An unknown id answers 200 with {"error":true,"iframe":true}.
  if (!data || data.error || !data.media) throw notFound(ref);
  if (data.media.protected) {
    throw new Vid2ContextError('unavailable', `Wistia media ${ref.nativeId} is password-protected.`, {
      hint: 'Only Wistia media that play without a password can be read.',
    });
  }
  return data.media;
}

function notFound(ref: VideoRef): Vid2ContextError {
  return new Vid2ContextError('not-found', `Wistia media ${ref.nativeId} was not found.`, {
    hint: 'Check the media id (the 10-character code in the embed or share link).',
  });
}

/** Wistia's thumbnail asset URL ends in .bin; the same delivery serves a JPEG at .jpg. */
function thumbnail(media: WistiaMedia): string | undefined {
  const still = (media.assets ?? [])
    .filter((a) => a.type === 'still_image' && a.url)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return still?.url?.replace(/\.bin$/, '.jpg');
}

export async function wistiaMetadata(ref: VideoRef, ctx: Ctx): Promise<VideoMetadata> {
  const m = await getMedia(ref, ctx);
  return {
    ref,
    title: m.name?.trim() || ref.nativeId,
    ...(m.seoDescription ? { description: m.seoDescription } : {}),
    ...(typeof m.duration === 'number' ? { durationSec: m.duration } : {}),
    ...(typeof m.createdAt === 'number' ? { publishedAt: new Date(m.createdAt * 1000).toISOString() } : {}),
    ...(thumbnail(m) ? { thumbnailUrl: thumbnail(m) } : {}),
    ...(m.language ? { language: m.language } : {}),
    chapters: [],
    ...(m.type ? { extra: { mediaType: m.type } } : {}),
  };
}

async function getCaptionList(ref: VideoRef, ctx: Ctx): Promise<WistiaCaption[]> {
  const res = await getText(ctx, `https://fast.wistia.com/embed/captions/${ref.nativeId}.json`);
  if (res.status !== 200)
    throw new Vid2ContextError('upstream', `Wistia captions ${ref.nativeId}: HTTP ${res.status}`, { status: res.status });
  return tryJson<{ captions?: WistiaCaption[] }>(res.body)?.captions ?? [];
}

const tagOf = (c: WistiaCaption): string => c.bcp47LanguageTag ?? c.language ?? 'und';

export function chooseWistiaCaption(captions: WistiaCaption[], language?: string, spoken?: string | null): WistiaCaption | null {
  const usable = captions.filter((c) => (c.hash?.lines?.length ?? 0) > 0);
  if (language) return usable.find((c) => langMatches(tagOf(c), language)) ?? null;
  if (spoken) {
    const s = usable.find((c) => langMatches(tagOf(c), spoken));
    if (s) return s;
  }
  if (usable.length <= 1) return usable[0] ?? null;
  return usable.find((c) => langMatches(tagOf(c), 'en')) ?? usable[0] ?? null;
}

/** Caption lines to segments. Extended audio descriptions ("Speaker 1.") describe the picture, not speech, and are dropped. */
export function wistiaSegments(c: WistiaCaption): Segment[] {
  const out: Segment[] = [];
  for (const line of c.hash?.lines ?? []) {
    if (line.extendedAudioDescription) continue;
    const text = line.text.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ startSec: line.start, endSec: Math.max(line.start, line.end), text });
  }
  return out;
}

export async function wistiaTracks(ref: VideoRef, ctx: Ctx): Promise<CaptionTrackInfo[]> {
  return (await getCaptionList(ref, ctx)).map((c) => ({
    language: tagOf(c),
    name: c.name ?? tagOf(c),
    origin: 'creator-captions',
  }));
}

export async function wistiaCaptions(
  ref: VideoRef,
  opts: CaptionOptions,
  ctx: Ctx,
): Promise<{ language: string; segments: Segment[] } | null> {
  const [media, captions] = await Promise.all([getMedia(ref, ctx), getCaptionList(ref, ctx)]);
  const picked = chooseWistiaCaption(captions, opts.language, media.language);
  return picked ? { language: tagOf(picked), segments: wistiaSegments(picked) } : null;
}
