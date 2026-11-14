/**
 * Records the fixtures for metadata without a player (fallbackMetadata):
 * the WEB `next` response, trimmed like record-metadata-fixtures.ts but
 * keeping the description text, and the oEmbed response. Both through the
 * real code path (fetchNext, oembedUrl). Usage:
 *   npx tsx providers/youtube/test/record-fallback-fixtures.ts providers/youtube/test/fixtures/metadata <videoId> ...
 * Then grep the output for your public IP and any email or phone number before committing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '@vid2context/core';
import { fetchNext, oembedUrl } from '../src/metadata/index.ts';

type Json = Record<string, unknown>;

/** Everything not needed by parseWatch: rich-text runs, buttons, images, commands, tracking. */
const DROP = new Set([
  'commandRuns',
  'styleRuns',
  'attachmentRuns',
  'decorationRuns',
  'headerRuns',
  'subscribeButton',
  'thumbnail',
  'thumbnails',
  'onActiveCommand',
  'onTap',
  'command',
  'serviceEndpoint',
  'commandMetadata',
  'watchEndpointSupportedOnesieConfig',
  'accessibility',
  'accessibilityData',
  'trackingParams',
  'clickTrackingParams',
  'loggingDirectives',
  'loggingContext',
  'serializedShareEntity',
  'onResponseReceivedEndpoints',
  'showMoreCommand',
  'showLessCommand',
]);

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) if (!DROP.has(k)) out[k] = strip(x);
    return out;
  }
  return v;
}

function trimNext(n: Json): Json {
  const results = (((n.contents as Json)?.twoColumnWatchNextResults as Json)?.results as Json)?.results as Json;
  const contents = (results?.contents as Json[] | undefined)?.filter(
    (c) => 'videoPrimaryInfoRenderer' in c || 'videoSecondaryInfoRenderer' in c,
  );
  const bar = ((n.playerOverlays as Json)?.playerOverlayRenderer as Json)?.decoratedPlayerBarRenderer;
  const out: Json = { contents: { twoColumnWatchNextResults: { results: { results: { contents } } } } };
  if (bar) out.playerOverlays = { playerOverlayRenderer: { decoratedPlayerBarRenderer: bar } };
  return strip(out) as Json;
}

const [outDir, ...ids] = process.argv.slice(2);
if (!outDir || ids.length === 0) throw new Error('usage: record-fallback-fixtures.ts <outDir> <videoId> ...');
mkdirSync(outDir, { recursive: true });
const ctx = createContext({ runtime: 'node', env: {} });
for (const id of ids) {
  const next = (await fetchNext(id, ctx)) as Json;
  writeFileSync(join(outDir, `next-fallback-${id}.json`), `${JSON.stringify(trimNext(next), null, 2)}\n`);
  const res = await fetch(oembedUrl(id));
  writeFileSync(join(outDir, `oembed-${id}.json`), `${JSON.stringify(await res.json(), null, 2)}\n`);
  console.error(`${id}: next ok, oEmbed HTTP ${res.status}`);
}
