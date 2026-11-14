/**
 * `media-stream`: HLS (.m3u8) and DASH (.mpd) URLs, plus the audio of direct
 * video URLs on Node. For streams, ffmpeg reads the playlist itself and
 * extracts compact speech audio. Direct video URLs are downloaded through
 * ctx.fetch to a temp file (VID2CONTEXT_MAX_MEDIA_MB enforced while streaming,
 * never held in memory), then ffmpeg extracts the audio locally.
 *
 * Metadata comes from the playlist: total duration (sum of segment durations
 * for HLS, mediaPresentationDuration for DASH), live or on-demand, variants
 * and audio and subtitle renditions. For a multi-variant HLS playlist, audio
 * is taken from the default audio rendition when it has its own playlist, else
 * from the lowest-bandwidth variant, so ffmpeg fetches as little as possible.
 *
 * ffmpeg only follows http and https (and TLS, TCP, AES) from these inputs,
 * never local files, so a hostile playlist cannot read the disk.
 */

import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  type AudioInput,
  type Ctx,
  defineProvider,
  errorFromResponse,
  fetchWithTimeout,
  type SourceProvider,
  Vid2ContextError,
  type VideoMetadata,
  type VideoRef,
} from '@vid2context/core';
import { extractAudio, type FfmpegTools, locateFfmpeg, probe, tryLocateFfmpeg, withTempDir } from '@vid2context/ffmpeg';
import {
  AUDIO_SIZED_BYTES,
  acceptableContentType,
  headMedia,
  isVideoUrl,
  maxMediaBytes,
  mediaRef,
  mediaUrlAudio,
  urlExtension,
  urlFileName,
} from '@vid2context/provider-media-url';

const STREAM_EXT: Record<string, 'hls' | 'dash'> = { '.m3u8': 'hls', '.mpd': 'dash' };
const GENERIC_NAMES = new Set([
  'master',
  'index',
  'playlist',
  'prog_index',
  'manifest',
  'main',
  'stream',
  'video',
  'chunklist',
  'media',
  'live',
]);

export function streamFormat(url: string): 'hls' | 'dash' | undefined {
  return STREAM_EXT[urlExtension(url)];
}

/** Recognise an HLS or DASH URL. Synchronous, no network. */
export function matchStream(raw: string): VideoRef | null {
  const input = raw.trim();
  if (!/^https?:\/\//i.test(input) || !streamFormat(input)) return null;
  try {
    return mediaRef(input, input);
  } catch {
    return null;
  }
}

/** Title from a stream URL; generic names (master.m3u8, index.m3u8) use the folder name instead. */
export function streamTitle(url: string): string {
  const u = new URL(url);
  const parts = u.pathname
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  const file = parts.pop() ?? '';
  const stem = file.replace(/\.[a-z0-9]+$/i, '');
  // Generic or empty names (master.m3u8, /tears-of-steel.ism/.m3u8) take the folder name, minus any extension.
  const generic = !stem || GENERIC_NAMES.has(stem.toLowerCase());
  const pick = generic && parts.length ? (parts.pop() ?? stem).replace(/\.[a-z0-9]+$/i, '') : stem;
  return pick.replace(/[_]+/g, ' ').trim() || u.hostname;
}

function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = line.slice(line.indexOf(':') + 1);
  for (const m of body.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    if (m[1]) out[m[1]] = (m[2] ?? '').replace(/^"|"$/g, '');
  }
  return out;
}

export interface HlsVariant {
  url: string;
  bandwidth?: number;
  codecs?: string;
  resolution?: string;
  audioGroup?: string;
}

export interface HlsRendition {
  type: string;
  groupId?: string;
  language?: string;
  name?: string;
  isDefault: boolean;
  url?: string;
}

export interface HlsInfo {
  kind: 'multivariant' | 'media';
  variants: HlsVariant[];
  renditions: HlsRendition[];
  /** Sum of #EXTINF durations (media playlists). */
  durationSec?: number;
  segments: number;
  /** True when a media playlist has no #EXT-X-ENDLIST and is not VOD. */
  isLive?: boolean;
}

/** Parse an HLS playlist. Relative URIs resolve against `baseUrl`. */
export function parseHlsPlaylist(text: string, baseUrl: string): HlsInfo {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') {
    throw new Vid2ContextError('unavailable', 'The URL did not return an HLS playlist (no #EXTM3U header).', {
      hint: 'Check the .m3u8 URL; it may need a signed token or have expired.',
    });
  }
  const abs = (u: string) => new URL(u, baseUrl).href;
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  let duration = 0;
  let segments = 0;
  let endList = false;
  let vod = false;
  let pendingVariant: Record<string, string> | null = null;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = attrs(line);
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line);
      renditions.push({
        type: a.TYPE ?? '',
        groupId: a['GROUP-ID'],
        language: a.LANGUAGE,
        name: a.NAME,
        isDefault: a.DEFAULT === 'YES',
        url: a.URI ? abs(a.URI) : undefined,
      });
    } else if (line.startsWith('#EXTINF:')) {
      const d = Number.parseFloat(line.slice(8));
      if (Number.isFinite(d)) duration += d;
      segments++;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      vod = line.endsWith('VOD');
    } else if (!line.startsWith('#') && pendingVariant) {
      const bw = Number(pendingVariant.BANDWIDTH);
      variants.push({
        url: abs(line),
        bandwidth: Number.isFinite(bw) ? bw : undefined,
        codecs: pendingVariant.CODECS,
        resolution: pendingVariant.RESOLUTION,
        audioGroup: pendingVariant.AUDIO,
      });
      pendingVariant = null;
    }
  }
  if (variants.length > 0) return { kind: 'multivariant', variants, renditions, segments: 0 };
  return {
    kind: 'media',
    variants,
    renditions,
    segments,
    durationSec: segments ? Math.round(duration * 1000) / 1000 : undefined,
    isLive: !endList && !vod,
  };
}

const VIDEO_CODEC = /avc1|avc3|hvc1|hev1|vp09|vp9|av01|mp4v/i;

/** The playlist ffmpeg should read for audio: the default audio rendition's own playlist, else the smallest (audio-only when possible) variant. */
export function pickAudioPlaylist(info: HlsInfo): string | undefined {
  const audio = info.renditions.filter((r) => r.type === 'AUDIO');
  // The default rendition decides: its own playlist when it has one; when its audio is
  // muxed into the variants (no URI), a variant, never a non-default alternate track.
  const chosen = audio.find((r) => r.isDefault) ?? audio[0];
  if (chosen?.url) return chosen.url;
  const byBandwidth = [...info.variants].sort(
    (a, b) => (a.bandwidth ?? Number.MAX_SAFE_INTEGER) - (b.bandwidth ?? Number.MAX_SAFE_INTEGER),
  );
  const audioOnly = byBandwidth.find((v) => v.codecs && !VIDEO_CODEC.test(v.codecs) && !v.resolution);
  return (audioOnly ?? byBandwidth[0])?.url;
}

export interface DashInfo {
  durationSec?: number;
  isLive: boolean;
  title?: string;
  adaptationSets: number;
  hasAudio: boolean;
}

/** ISO 8601 duration ('PT634.566S', 'PT1H2M3S', 'P1DT2H') in seconds. */
export function parseIsoDuration(text: string): number | undefined {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text.trim());
  if (!m) return undefined;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

/** Read the few MPD fields metadata needs, with regexes (no XML parser dependency). */
export function parseDashManifest(text: string): DashInfo {
  if (!/<MPD[\s>]/.test(text)) {
    throw new Vid2ContextError('unavailable', 'The URL did not return a DASH manifest (no <MPD> element).', {
      hint: 'Check the .mpd URL; it may need a signed token or have expired.',
    });
  }
  const mpd = /<MPD\b[^>]*>/.exec(text)?.[0] ?? '';
  const dur = /mediaPresentationDuration="([^"]+)"/.exec(mpd)?.[1];
  const title = /<Title>([^<]*)<\/Title>/.exec(text)?.[1]?.trim();
  const sets = text.match(/<AdaptationSet\b[^>]*>/g) ?? [];
  return {
    durationSec: dur ? parseIsoDuration(dur) : undefined,
    isLive: /\btype="dynamic"/.test(mpd),
    title: title || undefined,
    adaptationSets: sets.length,
    hasAudio: sets.some((s) => /contentType="audio"|mimeType="audio\//.test(s)) || /mimeType="audio\//.test(text),
  };
}

async function fetchText(url: string, ctx: Ctx): Promise<string> {
  const res = await fetchWithTimeout(ctx, url, { redirect: 'follow' }, 20_000);
  if (!res.ok) throw await errorFromResponse(res, 'stream manifest');
  const text = await res.text();
  if (text.length > 20 * 1024 * 1024) {
    throw new Vid2ContextError('too-large', 'The stream manifest is larger than 20 MB.', {
      hint: 'Check that the URL is a playlist.',
    });
  }
  return text;
}

export interface StreamInfo {
  format: 'hls' | 'dash';
  title: string;
  durationSec?: number;
  isLive: boolean;
  /** What ffmpeg reads for audio. */
  audioUrl: string;
  extra: Record<string, unknown>;
}

/** Fetch and summarise a stream manifest. */
export async function inspectStream(url: string, ctx: Ctx): Promise<StreamInfo> {
  const format = streamFormat(url);
  if (format === 'dash') {
    const d = parseDashManifest(await fetchText(url, ctx));
    return {
      format,
      title: d.title ?? streamTitle(url),
      durationSec: d.durationSec,
      isLive: d.isLive,
      audioUrl: url,
      extra: { url, format, adaptationSets: d.adaptationSets, hasAudio: d.hasAudio },
    };
  }
  const top = parseHlsPlaylist(await fetchText(url, ctx), url);
  if (top.kind === 'media') {
    return {
      format: 'hls',
      title: streamTitle(url),
      durationSec: top.durationSec,
      isLive: top.isLive ?? false,
      audioUrl: url,
      extra: { url, format: 'hls', segments: top.segments },
    };
  }
  const audioUrl = pickAudioPlaylist(top) ?? url;
  const media = parseHlsPlaylist(await fetchText(audioUrl, ctx), audioUrl);
  const subtitles = top.renditions.filter((r) => r.type === 'SUBTITLES');
  return {
    format: 'hls',
    title: streamTitle(url),
    durationSec: media.durationSec,
    isLive: media.isLive ?? false,
    audioUrl,
    extra: {
      url,
      format: 'hls',
      audioPlaylist: audioUrl,
      variants: top.variants.length,
      audioRenditions: top.renditions.filter((r) => r.type === 'AUDIO').map((r) => ({ name: r.name, language: r.language })),
      subtitleLanguages: [...new Set(subtitles.map((r) => r.language).filter(Boolean))],
      segments: media.segments,
    },
  };
}

function urlOf(ref: VideoRef): string {
  if (!ref.url) throw new Vid2ContextError('bad-request', `Media ref ${ref.id} has no URL.`);
  return ref.url;
}

async function ffmpegForAudio(ctx: Ctx): Promise<{ tools: FfmpegTools | null; error?: unknown }> {
  const installed = await tryLocateFfmpeg(ctx);
  if (installed) return { tools: installed };
  try {
    return { tools: await locateFfmpeg(ctx, { download: true }) };
  } catch (error) {
    return { tools: null, error };
  }
}

function tooLarge(size: number, cap: number): Vid2ContextError {
  return new Vid2ContextError(
    'too-large',
    `The video is ${(size / 1048576).toFixed(1)} MB, over the ${(cap / 1048576).toFixed(0)} MB limit.`,
    { hint: 'Raise VID2CONTEXT_MAX_MEDIA_MB, or link a shorter or audio-only file.' },
  );
}

/** Stream a URL to a file through ctx.fetch, refusing more than `maxBytes` and non-media responses. */
export async function downloadToFile(url: string, file: string, maxBytes: number, ctx: Ctx): Promise<number> {
  const head = await headMedia(url, ctx).catch(() => null);
  if (head?.sizeBytes !== undefined && head.sizeBytes > maxBytes) throw tooLarge(head.sizeBytes, maxBytes);
  const res = await fetchWithTimeout(ctx, url, { redirect: 'follow' }, 60 * 60_000);
  if (!res.ok) throw await errorFromResponse(res, 'media URL');
  const type = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!acceptableContentType(type) || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Vid2ContextError('unavailable', `The URL returned ${type ?? 'no body'}, not a video.`, {
      hint: 'Link the media file itself, not the page that plays it.',
    });
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw tooLarge(declared, maxBytes);
  }
  let total = 0;
  const out = createWriteStream(file);
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) controller.error(tooLarge(total, maxBytes));
      else controller.enqueue(chunk);
    },
  });
  await res.body.pipeThrough(counter).pipeTo(Writable.toWeb(out));
  return total;
}

function slug(text: string): string {
  return text.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 80) || 'stream';
}

export const mediaStream: SourceProvider = defineProvider({
  id: 'media-stream',
  kind: 'source',
  name: 'HLS and DASH streams (ffmpeg)',
  runtimes: ['node'],
  match: matchStream,
  async getMetadata(ref, ctx): Promise<VideoMetadata> {
    const info = await inspectStream(urlOf(ref), ctx);
    let durationSec = info.durationSec;
    if (durationSec === undefined && !info.isLive && (await tryLocateFfmpeg(ctx))) {
      durationSec = await probe(info.audioUrl, ctx)
        .then((p) => p.durationSec)
        .catch(() => undefined);
    }
    return {
      ref,
      title: info.title,
      chapters: [],
      isLive: info.isLive,
      ...(durationSec !== undefined ? { durationSec } : {}),
      extra: info.extra,
    };
  },
  // Streams need ffmpeg; direct video URLs on Node come here too so their audio is extracted instead of downloading the video.
  canProvideAudio: (ref, ctx) =>
    ctx.runtime === 'node' &&
    ref.platform === 'media' &&
    Boolean(ref.url) &&
    (Boolean(streamFormat(ref.url ?? '')) || isVideoUrl(ref.url ?? '')),
  async getAudio(ref, ctx): Promise<AudioInput> {
    const url = urlOf(ref);
    if (streamFormat(url)) {
      const info = await inspectStream(url, ctx);
      if (info.isLive) {
        throw new Vid2ContextError(
          'unavailable',
          'This is a live stream; only finished (on-demand) streams can be transcribed.',
          {
            hint: 'Try again once the broadcast has ended and a replay is published.',
          },
        );
      }
      const { tools, error } = await ffmpegForAudio(ctx);
      if (!tools) {
        throw new Vid2ContextError('unavailable', 'HLS and DASH streams need ffmpeg, and none was found.', {
          hint:
            error instanceof Vid2ContextError && error.hint ? error.hint : 'Install ffmpeg, or set FFMPEG_PATH and FFPROBE_PATH.',
          cause: error,
        });
      }
      return extractAudio(info.audioUrl, { format: 'mp3', name: slug(info.title) }, ctx);
    }

    // A direct video URL: download it (capped) and extract the audio locally.
    const cap = maxMediaBytes(ctx.env);
    const { tools } = await ffmpegForAudio(ctx);
    if (tools) {
      const fileName = urlFileName(url);
      const name = slug(fileName.replace(/\.[a-z0-9]+$/i, ''));
      return withTempDir(async (dir) => {
        const file = join(dir, `video${urlExtension(url) || '.bin'}`);
        await downloadToFile(url, file, cap, ctx);
        return extractAudio(file, { format: 'mp3', name }, ctx);
      });
    }
    ctx.log.info('ffmpeg not found; downloading the video for speech-to-text as is', { url });
    return mediaUrlAudio(
      ref,
      ctx,
      Math.min(cap, AUDIO_SIZED_BYTES),
      'Without ffmpeg only video files up to 25 MB can be transcribed. Install ffmpeg, or link the audio file.',
    );
  },
});
