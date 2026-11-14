/**
 * Read the fields vid2context uses from a `next` (watch page) response.
 * YouTube nests these deeply and reshuffles wrappers between releases, so
 * renderers are found by name anywhere in the tree rather than by a fixed
 * path. Shapes verified against the responses in test/fixtures/next-*.json.
 */

type Json = Record<string, unknown>;

export interface MarkerChapter {
  title: string;
  startSec: number;
}

export interface WatchInfo {
  /** The date line under the title, as shown: "Apr 23, 2005", "Streamed live on Jul 12, 2022", "Scheduled for Nov 15, 2026". */
  dateText?: string;
  /** ISO 8601 date (YYYY-MM-DD) read from dateText; absent for relative ("3 hours ago") and scheduled dates. */
  publishedAt?: string;
  likeCount?: number;
  /** People watching now (live) or waiting (upcoming), when YouTube shows it. */
  liveViewers?: number;
  channelName?: string;
  channelId?: string;
  /** "@name". */
  channelHandle?: string;
  /** As shown, for example "6.74M subscribers". */
  subscriberCountText?: string;
  membersOnly: boolean;
  /** YouTube's parse of the description timestamps (markers map key DESCRIPTION_CHAPTERS). */
  descriptionMarkers: MarkerChapter[];
  /** Auto-generated chapters, shown as "key moments" (markers map key AUTO_CHAPTERS). */
  autoChapters: MarkerChapter[];
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every value stored under `key`, depth first, up to `limit` matches. */
export function findAll(root: unknown, key: string, limit = Number.POSITIVE_INFINITY): unknown[] {
  const out: unknown[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0 && out.length < limit) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
    } else if (isObj(cur)) {
      const entries = Object.entries(cur);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i] as [string, unknown];
        if (k === key) out.push(v);
        else stack.push(v);
      }
    }
  }
  return out;
}

const first = (root: unknown, key: string): unknown => findAll(root, key, 1)[0];

function at(v: unknown, ...path: (string | number)[]): unknown {
  let cur = v;
  for (const key of path) {
    if (Array.isArray(cur) && typeof key === 'number') cur = cur[key];
    else if (isObj(cur) && typeof key === 'string') cur = cur[key];
    else return undefined;
  }
  return cur;
}

/** Text of a YouTube text object: { simpleText } or { runs: [{ text }] }. */
export function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return undefined;
  if (typeof v.simpleText === 'string') return v.simpleText;
  if (Array.isArray(v.runs)) {
    const t = v.runs.map((r) => (isObj(r) && typeof r.text === 'string' ? r.text : '')).join('');
    return t || undefined;
  }
  return undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Apr 23, 2005", "Premiered Jan 5, 2024", "Streamed live on Jul 12, 2022" -> "2005-04-23". Scheduled and relative dates -> undefined. */
export function parseDateText(text: string | undefined): string | undefined {
  if (!text || /^scheduled/i.test(text.trim())) return undefined;
  const m = /\b([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})\b/.exec(text);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1] ?? '');
  if (month < 0) return undefined;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** Digits of "20,138,292" or "10,418" as a number. */
const count = (s: string | undefined): number | undefined => {
  const digits = s?.replace(/[^\d]/g, '');
  return digits ? Number(digits) : undefined;
};

/** The exact like count, from the like button's label "like this video along with 20,138,292 other people". */
function likeCount(primary: unknown): number | undefined {
  for (const label of findAll(primary, 'accessibilityText')) {
    if (typeof label !== 'string') continue;
    const m = /along with ([\d,]+) other (?:people|person)/i.exec(label);
    if (m) return count(m[1]);
  }
  return undefined;
}

function markerChapters(root: unknown, key: 'DESCRIPTION_CHAPTERS' | 'AUTO_CHAPTERS'): MarkerChapter[] {
  for (const bar of findAll(root, 'multiMarkersPlayerBarRenderer')) {
    const map = at(bar, 'markersMap');
    if (!Array.isArray(map)) continue;
    const entry = map.find((m) => isObj(m) && m.key === key);
    const chapters = at(entry, 'value', 'chapters');
    if (!Array.isArray(chapters)) continue;
    const out: MarkerChapter[] = [];
    for (const c of chapters) {
      const r = at(c, 'chapterRenderer');
      const title = textOf(at(r, 'title'))?.trim();
      const ms = Number(at(r, 'timeRangeStartMillis'));
      if (title && Number.isFinite(ms)) out.push({ title, startSec: ms / 1000 });
    }
    return out;
  }
  return [];
}

export function parseWatch(next: unknown): WatchInfo {
  const primary = first(next, 'videoPrimaryInfoRenderer');
  const owner = at(first(next, 'videoSecondaryInfoRenderer'), 'owner', 'videoOwnerRenderer');
  const browse = at(owner, 'navigationEndpoint', 'browseEndpoint');
  const handlePath = at(browse, 'canonicalBaseUrl');
  const views = at(primary, 'viewCount', 'videoViewCountRenderer');
  const dateText = textOf(at(primary, 'dateText'));
  const badges = at(primary, 'badges');
  const info: WatchInfo = {
    dateText,
    publishedAt: parseDateText(dateText),
    likeCount: likeCount(primary),
    liveViewers: at(views, 'isLive') === true ? count(textOf(at(views, 'viewCount'))) : undefined,
    channelName: textOf(at(owner, 'title')),
    channelId: typeof at(browse, 'browseId') === 'string' ? (at(browse, 'browseId') as string) : undefined,
    channelHandle: typeof handlePath === 'string' && handlePath.startsWith('/@') ? handlePath.slice(1) : undefined,
    subscriberCountText: textOf(at(owner, 'subscriberCountText')),
    membersOnly: Array.isArray(badges) && badges.some((b) => at(b, 'metadataBadgeRenderer', 'style') === 'BADGE_STYLE_TYPE_MEMBERS_ONLY'),
    descriptionMarkers: markerChapters(next, 'DESCRIPTION_CHAPTERS'),
    autoChapters: markerChapters(next, 'AUTO_CHAPTERS'),
  };
  return info;
}
