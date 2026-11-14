import type { Chapter, VideoMetadata, VideoRef } from '@vid2context/core';
import { spokenLanguage, tracksOf } from './captions.ts';
import type { PlayerResponse } from './innertube.ts';

const TS = '((?:\\d{1,2}:)?\\d{1,2}:\\d{2})';
const SEP = '[-:|.\\u2013\\u2014]';
/** "0:00 Intro", "- 00:05 The cool thing", "(1:02:03) Outro", "[12:00] Q&A". */
const LEADING = new RegExp(`^\\s*(?:[-*\\u2022]\\s*)?[[(]?${TS}[\\])]?\\s*(?:${SEP}\\s*)?(.*\\S)\\s*$`);
/** "Intro - 0:00", "Intro (0:00)". */
const TRAILING = new RegExp(`^\\s*(.*?\\S)\\s*(?:${SEP}\\s*)?[[(]?${TS}[\\])]?\\s*$`);

export function parseClock(s: string): number {
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/**
 * Chapters the way YouTube derives them from a description: timestamped
 * lines, the first at 0:00, at least three, strictly ascending. Returns []
 * when the description does not qualify.
 */
export function parseDescriptionChapters(description: string | undefined, durationSec?: number): Chapter[] {
  if (!description) return [];
  const found: { title: string; startSec: number }[] = [];
  for (const line of description.split(/\r?\n/)) {
    const lead = LEADING.exec(line);
    if (lead?.[1] && lead[2]) {
      found.push({ startSec: parseClock(lead[1]), title: lead[2].trim() });
      continue;
    }
    const trail = TRAILING.exec(line);
    if (trail?.[1] && trail[2]) found.push({ startSec: parseClock(trail[2]), title: trail[1].trim() });
  }
  if (found.length < 3 || found[0]?.startSec !== 0) return [];
  for (let i = 1; i < found.length; i++) {
    const prev = found[i - 1];
    const cur = found[i];
    if (!prev || !cur || cur.startSec <= prev.startSec) return [];
  }
  return found.map((c, i) => {
    const endSec = found[i + 1]?.startSec ?? durationSec;
    return endSec === undefined ? { title: c.title, startSec: c.startSec } : { title: c.title, startSec: c.startSec, endSec };
  });
}

export function toMetadata(ref: VideoRef, player: PlayerResponse): VideoMetadata {
  const d = player.videoDetails;
  const durationSec = Number(d?.lengthSeconds) || undefined;
  const thumbs = d?.thumbnail?.thumbnails ?? [];
  const largest = [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  const meta: VideoMetadata = {
    ref,
    title: d?.title ?? ref.url ?? ref.input,
    description: d?.shortDescription,
    durationSec,
    thumbnailUrl: largest?.url,
    language: spokenLanguage(tracksOf(player)),
    tags: d?.keywords,
    chapters: parseDescriptionChapters(d?.shortDescription, durationSec),
    isLive: d?.isLive === true,
    extra: {
      viewCount: d?.viewCount === undefined ? undefined : Number(d.viewCount),
      isLiveContent: d?.isLiveContent,
      playability: player.playabilityStatus?.status,
    },
  };
  if (d?.author) {
    meta.channel = {
      name: d.author,
      id: d.channelId,
      url: d.channelId ? `https://www.youtube.com/channel/${d.channelId}` : undefined,
    };
  }
  return meta;
}
