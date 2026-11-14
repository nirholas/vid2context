/**
 * VideoMetadata from the view API, with tags and chapters (the player API's
 * view_points) added when those calls succeed. Multi-part videos describe the
 * requested part: its own title suffix, duration and cid.
 */
import type { Chapter, Ctx, VideoMetadata, VideoRef } from '@vid2context/core';
import { getPlayer, getTags, type Part, type ViewData } from './api.ts';
import { partRef, videoUrl } from './url.ts';

function https(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://');
}

export function partsOf(view: ViewData, input: string): VideoRef[] {
  const pages = view.pages?.length ? view.pages : [{ page: 1 }];
  return pages.map((p) => partRef(input, view.bvid, p.page));
}

export function baseMetadata(ref: VideoRef, part: Part): VideoMetadata {
  const { view, pageInfo } = part;
  const multi = (view.pages?.length ?? 1) > 1;
  const title = multi && pageInfo ? `${view.title} (P${pageInfo.page} ${pageInfo.part})` : view.title;
  return {
    ref: ref.nativeId.startsWith('b23:') ? partRef(ref.input, part.bvid, part.page) : ref,
    title,
    ...(view.owner
      ? { channel: { name: view.owner.name, id: String(view.owner.mid), url: `https://space.bilibili.com/${view.owner.mid}` } }
      : {}),
    ...(view.desc && view.desc !== '-' ? { description: view.desc } : {}),
    durationSec: pageInfo?.duration ?? view.duration,
    ...(view.pubdate ? { publishedAt: new Date(view.pubdate * 1000).toISOString() } : {}),
    ...(https(view.pic) ? { thumbnailUrl: https(view.pic) } : {}),
    chapters: [],
    extra: {
      bvid: view.bvid,
      aid: view.aid,
      cid: part.cid,
      part: part.page,
      parts: view.pages?.length ?? 1,
      ...(multi ? { partTitle: pageInfo?.part, videoUrl: videoUrl(view.bvid) } : {}),
      // copyright 1 = original upload, 2 = repost of someone else's work.
      ...(view.copyright ? { original: view.copyright === 1 } : {}),
      ...(view.tname_v2 || view.tname ? { category: view.tname_v2 || view.tname } : {}),
      ...(view.stat ? { views: view.stat.view, likes: view.stat.like, danmaku: view.stat.danmaku } : {}),
    },
  };
}

/** Tags and chapters are extras: a failure there never fails the metadata. */
export async function enrich(meta: VideoMetadata, part: Part, ctx: Ctx): Promise<VideoMetadata> {
  const [tags, player] = await Promise.allSettled([getTags(ctx, part.bvid), getPlayer(ctx, part.bvid, part.cid)]);
  if (tags.status === 'fulfilled') {
    const names = tags.value.map((t) => t.tag_name).filter(Boolean);
    if (names.length) meta.tags = names;
  } else {
    ctx.log.debug('bilibili tags failed', { bvid: part.bvid, error: String(tags.reason) });
  }
  if (player.status === 'fulfilled') {
    const chapters: Chapter[] = (player.value.view_points ?? [])
      .filter((v) => v.content)
      .map((v) => ({ title: v.content, startSec: v.from, endSec: v.to }));
    meta.chapters = chapters;
  } else {
    ctx.log.debug('bilibili player info failed', { bvid: part.bvid, error: String(player.reason) });
  }
  return meta;
}

/** Metadata for the list of parts of a multi-part video. */
export function listMetadata(ref: VideoRef, view: ViewData): VideoMetadata {
  return {
    ref,
    title: view.title,
    ...(view.owner
      ? { channel: { name: view.owner.name, id: String(view.owner.mid), url: `https://space.bilibili.com/${view.owner.mid}` } }
      : {}),
    ...(view.desc && view.desc !== '-' ? { description: view.desc } : {}),
    durationSec: view.duration,
    ...(view.pubdate ? { publishedAt: new Date(view.pubdate * 1000).toISOString() } : {}),
    ...(https(view.pic) ? { thumbnailUrl: https(view.pic) } : {}),
    chapters: [],
    extra: {
      bvid: view.bvid,
      aid: view.aid,
      parts: (view.pages ?? []).map((p) => ({
        page: p.page,
        title: p.part,
        durationSec: p.duration,
        url: videoUrl(view.bvid, p.page),
      })),
    },
  };
}
