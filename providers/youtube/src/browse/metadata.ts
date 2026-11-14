/**
 * Metadata for playlist, channel and search refs, read from the same browse
 * responses the listing uses. `extra.kind` says which kind of list it is and
 * `extra.itemCount` carries the count YouTube shows in the header.
 */
import { type Ctx, Vid2ContextError, type VideoMetadata, type VideoRef } from '@vid2context/core';
import { parseSearchRef } from '../url.ts';
import { SHOW_UNAVAILABLE } from './list.ts';
import { findString, parsePage, textOf } from './parse.ts';
import { innertubeWeb, type Json } from './request.ts';

function at(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[key];
  }
  return cur;
}

/** Every text part in the page header's metadata rows: "by Christiaan008", "96 videos", "15.1K subscribers". */
function headerParts(json: Json): { text: string; browseId?: string; url?: string }[] {
  const rows = at(
    json,
    'header',
    'pageHeaderRenderer',
    'content',
    'pageHeaderViewModel',
    'metadata',
    'contentMetadataViewModel',
    'metadataRows',
  );
  const out: { text: string; browseId?: string; url?: string }[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const parts = at(row, 'metadataParts');
    for (const part of Array.isArray(parts) ? parts : []) {
      const textObj = at(part, 'text') ?? at(part, 'avatarStack', 'avatarStackViewModel', 'text');
      const text = textOf(textObj);
      if (!text) continue;
      const browseId = findString(at(textObj, 'commandRuns'), 'browseId');
      const url = findString(at(textObj, 'commandRuns'), 'canonicalBaseUrl');
      out.push({ text, ...(browseId ? { browseId } : {}), ...(url ? { url } : {}) });
    }
  }
  return out;
}

function itemCount(parts: { text: string }[]): number | undefined {
  for (const p of parts) {
    const m = /^([\d,]+) (?:videos?|episodes?|songs?)$/i.exec(p.text.trim());
    if (m?.[1]) return Number(m[1].replace(/,/g, ''));
  }
  return undefined;
}

function thumbnail(json: Json): string | undefined {
  const thumbs = at(json, 'microformat', 'microformatDataRenderer', 'thumbnail', 'thumbnails');
  if (!Array.isArray(thumbs) || thumbs.length === 0) return undefined;
  const last = thumbs[thumbs.length - 1] as { url?: unknown };
  return typeof last.url === 'string' ? last.url : undefined;
}

function failOnAlert(json: Json, what: string): void {
  const err = parsePage(json, { continuation: false }).alerts.find((a) => a.type === 'ERROR');
  if (err) {
    throw new Vid2ContextError('not-found', `YouTube ${what}: ${err.text}`, {
      hint: 'Check the URL. Private, deleted and mistyped playlists or channels have no metadata.',
    });
  }
}

async function playlistMetadata(ref: VideoRef, ctx: Ctx): Promise<VideoMetadata> {
  const list = ref.nativeId;
  const json = await innertubeWeb('browse', { browseId: `VL${list}`, params: SHOW_UNAVAILABLE }, ctx);
  failOnAlert(json, `playlist ${list}`);
  const meta = at(json, 'metadata', 'playlistMetadataRenderer');
  const parts = headerParts(json);
  const owner = parts.find((p) => p.browseId?.startsWith('UC'));
  const title = textOf(at(meta, 'title')) ?? textOf(at(json, 'header', 'pageHeaderRenderer', 'pageTitle')) ?? list;
  const description = textOf(at(meta, 'description'));
  const count = itemCount(parts);
  const thumb = thumbnail(json);
  return {
    ref,
    title,
    ...(owner
      ? {
          channel: {
            name: owner.text.replace(/^by /, ''),
            id: owner.browseId,
            url: `https://www.youtube.com${owner.url ?? `/channel/${owner.browseId}`}`,
          },
        }
      : {}),
    ...(description ? { description } : {}),
    ...(thumb ? { thumbnailUrl: thumb } : {}),
    chapters: [],
    extra: { kind: 'playlist', ...(count !== undefined ? { itemCount: count } : {}) },
  };
}

async function channelMetadata(ref: VideoRef, ctx: Ctx): Promise<VideoMetadata> {
  let body: Json = { browseId: ref.nativeId };
  if (!ref.nativeId.startsWith('UC')) {
    const resolved = await innertubeWeb('navigation/resolve_url', { url: ref.url }, ctx);
    const be = at(resolved, 'endpoint', 'browseEndpoint') as { browseId?: string; params?: string } | undefined;
    if (!be?.browseId)
      throw new Vid2ContextError('not-found', `YouTube did not resolve ${ref.url} to a channel.`, {
        hint: 'Check the handle or channel name.',
      });
    body = { browseId: be.browseId, ...(be.params ? { params: be.params } : {}) };
  }
  const json = await innertubeWeb('browse', body, ctx);
  failOnAlert(json, `channel ${ref.nativeId}`);
  const meta = at(json, 'metadata', 'channelMetadataRenderer');
  const title = textOf(at(meta, 'title')) ?? ref.nativeId;
  const id = textOf(at(meta, 'externalId')) ?? String(body.browseId);
  const url = textOf(at(meta, 'vanityChannelUrl'))?.replace(/^http:/, 'https:') ?? `https://www.youtube.com/channel/${id}`;
  const description = textOf(at(meta, 'description'));
  const parts = headerParts(json);
  const handle = parts.find((p) => p.text.startsWith('@'))?.text;
  const count = itemCount(parts);
  const thumb = findString(at(meta, 'avatar'), 'url');
  return {
    ref,
    title,
    channel: { name: title, id, url },
    ...(description ? { description } : {}),
    ...(thumb ? { thumbnailUrl: thumb } : {}),
    chapters: [],
    extra: { kind: 'channel', ...(handle ? { handle } : {}), ...(count !== undefined ? { itemCount: count } : {}) },
  };
}

/** `getMetadata` for list refs. Search refs need no request: their metadata is the query. */
export async function listMetadata(ref: VideoRef, ctx: Ctx): Promise<VideoMetadata> {
  const search = parseSearchRef(ref);
  if (search) {
    return {
      ref,
      title: `YouTube search: ${search.query}`,
      chapters: [],
      extra: { kind: 'search', query: search.query, ...(search.count ? { count: search.count } : {}) },
    };
  }
  if (ref.kind === 'playlist') return playlistMetadata(ref, ctx);
  if (ref.kind === 'channel') return channelMetadata(ref, ctx);
  throw new Vid2ContextError('unsupported-input', `YouTube has no list metadata for a ${ref.kind} ref.`, {
    hint: 'Pass a playlist, channel or ytsearch: input.',
  });
}
