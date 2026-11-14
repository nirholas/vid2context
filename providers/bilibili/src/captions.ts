/**
 * Bilibili subtitles. The player API (/x/player/wbi/v2) lists subtitles only
 * for signed-in sessions (it answers need_login_subtitle: true with an empty
 * list otherwise), while /x/v2/dm/view returns the same list with fetchable
 * URLs anonymously, so that is the primary source. With BILIBILI_SESSDATA set
 * the player list is merged in as well.
 *
 * type 0 is a subtitle uploaded by a person (the creator or a credited
 * contributor): creator-captions. type 1, or a lan starting with "ai-", is
 * bilibili's speech recognition: auto-captions. Bodies are JSON:
 * { body: [{ from, to, content }] } with times in seconds.
 */
import {
  type CaptionOptions,
  type CaptionTrackInfo,
  type Ctx,
  fetchWithTimeout,
  type Segment,
  Vid2ContextError,
} from '@vid2context/core';
import { getPlayer, getSubtitleList, type Part, REFERER, type SubtitleInfo, USER_AGENT } from './api.ts';

export interface Track {
  lan: string;
  name: string;
  /** BCP-47 language of the text. */
  language: string;
  origin: 'creator-captions' | 'auto-captions';
  url: string;
}

function https(url: string): string {
  return url.replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://');
}

/** 'ai-zh' -> 'zh', 'zh-CN' stays 'zh-CN'. */
export function languageOf(lan: string): string {
  return lan.replace(/^ai-/i, '') || 'und';
}

export function toTrack(s: SubtitleInfo): Track | null {
  if (!s.subtitle_url || !s.lan) return null;
  const auto = s.type === 1 || /^ai-/i.test(s.lan);
  return {
    lan: s.lan,
    name: s.lan_doc ?? s.lan,
    language: languageOf(s.lan),
    origin: auto ? 'auto-captions' : 'creator-captions',
    url: https(s.subtitle_url),
  };
}

export async function listTracks(part: Part, ctx: Ctx): Promise<Track[]> {
  const lists: SubtitleInfo[] = [];
  const dm = await getSubtitleList(ctx, part.view.aid, part.cid);
  lists.push(...(dm.subtitle?.subtitles ?? []));
  if (ctx.env.BILIBILI_SESSDATA?.trim()) {
    try {
      const player = await getPlayer(ctx, part.bvid, part.cid);
      lists.push(...(player.subtitle?.subtitles ?? []));
    } catch (err) {
      ctx.log.debug('bilibili player subtitle list failed', { bvid: part.bvid, error: String(err) });
    }
  }
  const byLan = new Map<string, Track>();
  for (const s of lists) {
    const t = toTrack(s);
    if (t && !byLan.has(t.lan)) byLan.set(t.lan, t);
  }
  return [...byLan.values()];
}

function primary(lang: string): string {
  return lang.split(/[-_]/)[0]?.toLowerCase() ?? '';
}

/**
 * Best track for the options: creator subtitles before auto ones; with a
 * language, an exact match before a primary-subtag match. Bilibili offers no
 * machine translation, so a language with no track gives null.
 */
export function chooseTrack(tracks: Track[], opts: CaptionOptions): Track | null {
  const allowed = tracks.filter((t) => opts.allowAuto !== false || t.origin === 'creator-captions');
  const rank = (t: Track) => (t.origin === 'creator-captions' ? 0 : 1);
  const sorted = [...allowed].sort((a, b) => rank(a) - rank(b));
  if (!opts.language) return sorted[0] ?? null;
  const want = opts.language.toLowerCase();
  return (
    sorted.find((t) => t.language.toLowerCase() === want) ?? sorted.find((t) => primary(t.language) === primary(want)) ?? null
  );
}

interface SubtitleBody {
  body?: { from: number; to: number; content: string }[];
}

export function toSegments(json: SubtitleBody): Segment[] {
  return (json.body ?? [])
    .map((l) => ({
      startSec: Number(l.from),
      endSec: Number(l.to),
      text: String(l.content ?? '')
        .replace(/\s*\n\s*/g, ' ')
        .trim(),
    }))
    .filter((s) => s.text.length > 0 && Number.isFinite(s.startSec) && Number.isFinite(s.endSec));
}

export async function fetchTrack(track: Track, ctx: Ctx): Promise<Segment[]> {
  // The subtitle CDN needs no session, so the SESSDATA cookie is not sent there.
  const res = await fetchWithTimeout(ctx, track.url, { headers: { 'user-agent': USER_AGENT, referer: REFERER } });
  if (!res.ok) {
    throw new Vid2ContextError(
      res.status === 404 ? 'not-found' : 'upstream',
      `Bilibili subtitle ${track.lan}: HTTP ${res.status}`,
      {
        status: res.status,
      },
    );
  }
  return toSegments((await res.json()) as SubtitleBody);
}

export function trackInfo(t: Track): CaptionTrackInfo {
  return { language: t.language, name: t.name, origin: t.origin };
}
