/**
 * Loom, keyless. A public share page (loom.com/share/<id>) server-renders its
 * GraphQL cache as `window.__APOLLO_STATE__`. That object holds the video
 * (title, description, owner, duration, chapters, privacy) and its transcript
 * details, including a signed, short-lived URL for the captions file (WebVTT).
 * Loom produces those captions with its own speech recognition, so they are
 * auto-captions. No undocumented API is called: only the page a browser opens
 * and the captions URL that page hands out.
 */
import {
  type CaptionOptions,
  type CaptionTrackInfo,
  type Chapter,
  type Ctx,
  type Segment,
  Vid2ContextError,
  type VideoMetadata,
  type VideoRef,
} from '@vid2context/core';
import { getText, langMatches } from './http.ts';
import { parseVtt } from './vtt.ts';

const ID = /^[0-9a-f]{32}$/i;
const HOSTS = new Set(['loom.com', 'www.loom.com']);

function videoRef(input: string, id: string): VideoRef {
  const lower = id.toLowerCase();
  return {
    input,
    platform: 'loom',
    kind: 'video',
    id: `loom:${lower}`,
    nativeId: lower,
    url: `https://www.loom.com/share/${lower}`,
  };
}

/** loom.com/share/<id>, loom.com/share/<title-slug>-<id> and loom.com/embed/<id>. */
export function matchLoom(raw: string): VideoRef | null {
  const input = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !HOSTS.has(url.hostname.toLowerCase())) return null;
  const [kind, slug, ...rest] = url.pathname.split('/').filter(Boolean);
  if ((kind !== 'share' && kind !== 'embed') || !slug || rest.length > 0) return null;
  const id = slug.slice(-32);
  if (!ID.test(id) || (slug.length > 32 && slug[slug.length - 33] !== '-')) return null;
  return videoRef(input, id);
}

type ApolloState = Record<string, Record<string, unknown> | undefined>;

/** Extract the JSON object literal that starts at `from` (the first "{"), honouring strings and escapes. */
export function extractJsonObject(s: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(from, i + 1);
    }
  }
  return null;
}

/** Read `window.__APOLLO_STATE__` from a share page, or null when the page has none. */
export function apolloState(html: string): ApolloState | null {
  const marker = html.indexOf('window.__APOLLO_STATE__');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  const json = start < 0 ? null : extractJsonObject(html, start);
  if (!json) return null;
  try {
    return JSON.parse(json) as ApolloState;
  } catch {
    return null;
  }
}

function deref(state: ApolloState, value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ref = (value as { __ref?: unknown }).__ref;
  return typeof ref === 'string' ? state[ref] : (value as Record<string, unknown>);
}

function rootField(state: ApolloState, prefix: string): unknown {
  const root = state.ROOT_QUERY ?? {};
  const key = Object.keys(root).find((k) => k.startsWith(prefix));
  return key === undefined ? undefined : root[key];
}

export interface LoomPage {
  video?: Record<string, unknown>;
  owner?: Record<string, unknown>;
  transcript?: Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Fetch and read the share page. Throws `not-found`, `unavailable` (password or private) or `upstream`. */
export async function getLoomPage(ref: VideoRef, ctx: Ctx): Promise<LoomPage> {
  const res = await getText(ctx, `https://www.loom.com/share/${ref.nativeId}`);
  const state = apolloState(res.body);
  if (!state) {
    if (res.status === 404) throw notFound(ref);
    throw new Vid2ContextError('upstream', `Loom share page for ${ref.nativeId}: HTTP ${res.status} without video data.`, {
      status: res.status,
      hint: 'Loom may have changed its share page. Try again later, or let yt-dlp fetch the audio for speech-to-text.',
    });
  }
  const video = deref(state, rootField(state, 'getVideo('));
  if (!video) throw notFound(ref);
  if (video.needs_password === true) {
    throw new Vid2ContextError('unavailable', `Loom video ${ref.nativeId} is password-protected.`, {
      hint: 'Only Loom videos shared with "anyone with the link" can be read without signing in.',
    });
  }
  const transcriptField = deref(state, rootField(state, 'fetchVideoTranscript('));
  return {
    video,
    owner: deref(state, video.owner),
    transcript: transcriptField?.__typename === 'VideoTranscriptDetails' ? transcriptField : undefined,
  };
}

function notFound(ref: VideoRef): Vid2ContextError {
  return new Vid2ContextError('not-found', `Loom video ${ref.nativeId} was not found or is not shared publicly.`, {
    status: 404,
    hint: 'Check the link, and that the video is shared with "anyone with the link".',
  });
}

/** "00:00 Intro\n00:47 Next" (Loom's chapters text) -> chapters, each ending where the next starts. */
export function parseLoomChapters(text: string | undefined, durationSec?: number): Chapter[] {
  if (!text) return [];
  const out: Chapter[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/.exec(line);
    if (!m?.[4]) continue;
    out.push({ title: m[4], startSec: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) });
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out.map((c, i) => {
    const end = out[i + 1]?.startSec ?? durationSec;
    return end !== undefined && end > c.startSec ? { ...c, endSec: end } : c;
  });
}

export async function loomMetadata(ref: VideoRef, ctx: Ctx): Promise<VideoMetadata> {
  const { video = {}, owner, transcript } = await getLoomPage(ref, ctx);
  const durationSec = num(video.playable_duration) ?? num(video.source_duration);
  const thumbs = video.thumbnails as { default?: unknown } | undefined;
  const ownerName = str(owner?.display_name);
  const language = str(transcript?.language);
  const extra: Record<string, unknown> = {};
  if (str(video.privacy)) extra.privacy = video.privacy;
  return {
    ref,
    title: str(video.name) ?? ref.nativeId,
    ...(ownerName ? { channel: { name: ownerName, ...(str(owner?.id) ? { id: str(owner?.id) } : {}) } } : {}),
    ...(str(video.description) ? { description: str(video.description) } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(str(video.createdAt) ? { publishedAt: str(video.createdAt) } : {}),
    ...(str(thumbs?.default) ? { thumbnailUrl: str(thumbs?.default) } : {}),
    ...(language ? { language } : {}),
    chapters: parseLoomChapters(str(video.chapters), durationSec),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

function trackOf(transcript: Record<string, unknown> | undefined): { url: string; language: string; service?: string } | null {
  const url = str(transcript?.captions_source_url);
  if (!transcript || !url || transcript.transcription_status !== 'success') return null;
  return { url, language: str(transcript.language) ?? 'und', service: str(transcript.processing_service) };
}

export async function loomTracks(ref: VideoRef, ctx: Ctx): Promise<CaptionTrackInfo[]> {
  const track = trackOf((await getLoomPage(ref, ctx)).transcript);
  return track ? [{ language: track.language, name: track.language, origin: 'auto-captions' }] : [];
}

export async function loomCaptions(
  ref: VideoRef,
  opts: CaptionOptions,
  ctx: Ctx,
): Promise<{ language: string; service?: string; segments: Segment[] } | null> {
  if (opts.allowAuto === false) return null;
  const track = trackOf((await getLoomPage(ref, ctx)).transcript);
  if (!track) return null;
  if (opts.language && !langMatches(track.language, opts.language)) return null;
  const res = await getText(ctx, track.url);
  if (res.status !== 200) {
    throw new Vid2ContextError('upstream', `Loom captions for ${ref.nativeId}: HTTP ${res.status}`, { status: res.status });
  }
  return { language: track.language, service: track.service, segments: parseVtt(res.body) };
}
