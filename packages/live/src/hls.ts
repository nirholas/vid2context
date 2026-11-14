/**
 * HLS playlist parsing (RFC 8216), only as much as following a live stream
 * needs: master playlists (variants and audio renditions) and media playlists
 * (media sequence, target duration, segment durations, program date time,
 * init sections, encryption and the end marker). Runtime-neutral.
 */

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number;
  codecs: string[];
  resolution?: string;
  /** GROUP-ID of the audio renditions this variant uses (EXT-X-MEDIA TYPE=AUDIO). */
  audioGroup?: string;
}

export interface HlsRendition {
  type: string;
  groupId: string;
  name?: string;
  language?: string;
  uri?: string;
  isDefault: boolean;
}

export interface MasterPlaylist {
  kind: 'master';
  variants: HlsVariant[];
  renditions: HlsRendition[];
}

export interface MediaSegment {
  /** Media sequence number (EXT-X-MEDIA-SEQUENCE plus the position in the playlist). */
  sequence: number;
  uri: string;
  /** EXTINF duration in seconds. */
  duration: number;
  /** EXT-X-PROGRAM-DATE-TIME for this segment, as epoch milliseconds, when the playlist carries it. */
  programDateMs?: number;
  /** URI of the EXT-X-MAP init section that applies to this segment (fragmented MP4 streams). */
  initUri?: string;
  /** EXT-X-KEY METHOD in force for this segment, when not NONE. */
  encryption?: string;
  /** EXT-X-DISCONTINUITY before this segment. */
  discontinuity: boolean;
}

export interface MediaPlaylist {
  kind: 'media';
  targetDuration: number;
  mediaSequence: number;
  /** True when the playlist carries EXT-X-ENDLIST: the stream has ended and no segment will be added. */
  endList: boolean;
  /** EXT-X-PLAYLIST-TYPE (EVENT or VOD) when present. */
  playlistType?: string;
  segments: MediaSegment[];
}

export type Playlist = MasterPlaylist | MediaPlaylist;

/** Parse an attribute list: KEY=VALUE pairs, quoted strings may contain commas. */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const m of s.matchAll(re)) {
    const key = m[1];
    const raw = m[2] ?? '';
    if (key) out[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

function resolveUri(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

function tagValue(line: string): string {
  const i = line.indexOf(':');
  return i === -1 ? '' : line.slice(i + 1);
}

/** True when the text looks like an HLS playlist. */
export function isPlaylist(text: string): boolean {
  return text.trimStart().startsWith('#EXTM3U');
}

/** Parse a master or media playlist. Relative URIs are resolved against `baseUrl`. */
export function parsePlaylist(text: string, baseUrl: string): Playlist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], baseUrl: string): MasterPlaylist {
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  let pending: Record<string, string> | null = null;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(tagValue(line));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(tagValue(line));
      renditions.push({
        type: a.TYPE ?? '',
        groupId: a['GROUP-ID'] ?? '',
        ...(a.NAME ? { name: a.NAME } : {}),
        ...(a.LANGUAGE ? { language: a.LANGUAGE } : {}),
        ...(a.URI ? { uri: resolveUri(a.URI, baseUrl) } : {}),
        isDefault: a.DEFAULT === 'YES',
      });
    } else if (!line.startsWith('#') && pending) {
      const avg = Number(pending['AVERAGE-BANDWIDTH']);
      variants.push({
        uri: resolveUri(line, baseUrl),
        bandwidth: Number(pending.BANDWIDTH) || 0,
        ...(Number.isFinite(avg) && avg > 0 ? { averageBandwidth: avg } : {}),
        codecs: (pending.CODECS ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
        ...(pending.RESOLUTION ? { resolution: pending.RESOLUTION } : {}),
        ...(pending.AUDIO ? { audioGroup: pending.AUDIO } : {}),
      });
      pending = null;
    }
  }
  return { kind: 'master', variants, renditions };
}

function parseMedia(lines: string[], baseUrl: string): MediaPlaylist {
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let playlistType: string | undefined;
  const segments: MediaSegment[] = [];
  let duration: number | null = null;
  let programDateMs: number | undefined;
  let initUri: string | undefined;
  let encryption: string | undefined;
  let discontinuity = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(tagValue(line)) || 0;
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = Number(tagValue(line)) || 0;
    else if (line.startsWith('#EXT-X-ENDLIST')) endList = true;
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = tagValue(line);
    else if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(tagValue(line).split(',')[0] ?? '') || 0;
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const ms = Date.parse(tagValue(line));
      programDateMs = Number.isFinite(ms) ? ms : undefined;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const uri = parseAttributes(tagValue(line)).URI;
      initUri = uri ? resolveUri(uri, baseUrl) : undefined;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const method = parseAttributes(tagValue(line)).METHOD;
      encryption = method && method !== 'NONE' ? method : undefined;
    } else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
      discontinuity = true;
    } else if (!line.startsWith('#') && duration !== null) {
      segments.push({
        sequence: mediaSequence + segments.length,
        uri: resolveUri(line, baseUrl),
        duration,
        ...(programDateMs !== undefined ? { programDateMs } : {}),
        ...(initUri ? { initUri } : {}),
        ...(encryption ? { encryption } : {}),
        discontinuity,
      });
      // A program date time applies to the next segment only; later ones follow by duration.
      programDateMs = programDateMs !== undefined ? programDateMs + duration * 1000 : undefined;
      duration = null;
      discontinuity = false;
    }
  }
  return { kind: 'media', targetDuration, mediaSequence, endList, ...(playlistType ? { playlistType } : {}), segments };
}

const AUDIO_CODEC = /^(mp4a|ac-3|ec-3|opus|mp3|flac|vorbis|alac)/i;
const VIDEO_CODEC = /^(avc|hvc|hev|vp0?8|vp0?9|av01|dvh|dva)/i;

export function hasAudioCodec(v: HlsVariant): boolean {
  return v.codecs.some((c) => AUDIO_CODEC.test(c));
}

/**
 * The cheapest way to get the audio of a master playlist:
 * 1. an audio-only rendition (EXT-X-MEDIA TYPE=AUDIO with a URI), the default one first, matching `language` when given;
 * 2. else the lowest-bandwidth variant whose CODECS include an audio codec;
 * 3. else, when no variant declares codecs, the lowest-bandwidth variant.
 * Returns null when nothing carries audio.
 */
export function pickAudioUri(master: MasterPlaylist, language?: string): string | null {
  const audio = master.renditions.filter((r) => r.type === 'AUDIO' && r.uri);
  if (audio.length > 0) {
    const lang = language?.toLowerCase().split('-')[0];
    const byLang = lang ? audio.filter((r) => r.language?.toLowerCase().startsWith(lang)) : [];
    const pool = byLang.length > 0 ? byLang : audio;
    const pick = pool.find((r) => r.isDefault) ?? pool[0];
    if (pick?.uri) return pick.uri;
  }
  const byBandwidth = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth);
  const withAudio = byBandwidth.filter(hasAudioCodec);
  if (withAudio[0]) return withAudio[0].uri;
  const undeclared = byBandwidth.filter((v) => v.codecs.length === 0 || !v.codecs.every((c) => VIDEO_CODEC.test(c)));
  return undeclared[0]?.uri ?? null;
}
