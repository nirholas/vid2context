/**
 * Records metadata fixtures through the real code path: prompt 06's getPlayer,
 * this prompt's fetchNext and the maxres HEAD check. Usage:
 *   npx tsx providers/youtube/test/record-metadata-fixtures.ts providers/youtube/test/fixtures/metadata <label>:<videoId> ...
 * Then grep the output for your public IP and any email or phone number before committing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '@vid2context/core';
import { fetchNext, findMaxres } from '../src/metadata/index.ts';
import { getPlayer } from '../src/resilience/player.ts';

type Json = Record<string, unknown>;
const NEXT_ONLY = [
  'attributedDescription',
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
];
const BASE = [
  'trackingParams',
  'clickTrackingParams',
  'loggingDirectives',
  'loggingContext',
  'serializedShareEntity',
  'onResponseReceivedEndpoints',
];
const PLAYER_DROP = new Set(BASE);
const NEXT_DROP = new Set([...BASE, ...NEXT_ONLY]);

function strip(v: unknown, drop: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => strip(x, drop));
  if (v && typeof v === 'object') {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) if (!drop.has(k)) out[k] = strip(x, drop);
    return out;
  }
  return v;
}

function trimPlayer(p: Json): Json {
  const ps = (p.playabilityStatus ?? {}) as Json;
  const sd = (p.streamingData ?? {}) as Json;
  const dims = (list: unknown) =>
    Array.isArray(list)
      ? list
          .filter((f) => (f as Json).width)
          .map((f) => ({
            itag: (f as Json).itag,
            mimeType: (f as Json).mimeType,
            width: (f as Json).width,
            height: (f as Json).height,
          }))
      : undefined;
  const out: Json = {
    playabilityStatus: { status: ps.status, reason: ps.reason, liveStreamability: ps.liveStreamability },
    videoDetails: p.videoDetails,
    captions: p.captions,
  };
  if (p.streamingData) out.streamingData = { formats: dims(sd.formats), adaptiveFormats: dims(sd.adaptiveFormats) };
  return strip(JSON.parse(JSON.stringify(out)), PLAYER_DROP) as Json;
}

function trimNext(n: Json): Json {
  const results = (((n.contents as Json)?.twoColumnWatchNextResults as Json)?.results as Json)?.results as Json;
  const contents = (results?.contents as Json[] | undefined)?.filter(
    (c) => 'videoPrimaryInfoRenderer' in c || 'videoSecondaryInfoRenderer' in c,
  );
  const bar = ((n.playerOverlays as Json)?.playerOverlayRenderer as Json)?.decoratedPlayerBarRenderer;
  const out: Json = { contents: { twoColumnWatchNextResults: { results: { results: { contents } } } } };
  if (bar) out.playerOverlays = { playerOverlayRenderer: { decoratedPlayerBarRenderer: bar } };
  return strip(out, NEXT_DROP) as Json;
}

const [outDir, ...specs] = process.argv.slice(2);
if (!outDir) throw new Error('usage: record-metadata-fixtures.ts <outDir> <label>:<id> ...');
mkdirSync(outDir, { recursive: true });
const maxresFile = join(outDir, 'maxres-status.json');
const maxres: Record<string, number> = existsSync(maxresFile) ? JSON.parse(readFileSync(maxresFile, 'utf8')) : {};
for (const spec of specs) {
  const [label, id] = spec.split(':') as [string, string];
  const heads: number[] = [];
  const ctx = createContext({
    runtime: 'node',
    env: {},
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      if (init?.method === 'HEAD') heads.push(res.status);
      return res;
    },
  });
  const player = (await getPlayer(id, ctx)) as unknown as Json;
  const client = player.client;
  delete player.client;
  delete player.attempts;
  writeFileSync(join(outDir, `player-${label}-${id}.json`), `${JSON.stringify(trimPlayer(player), null, 2)}\n`);
  const next = (await fetchNext(id, ctx)) as Json;
  writeFileSync(join(outDir, `next-${label}-${id}.json`), `${JSON.stringify(trimNext(next), null, 2)}\n`);
  await findMaxres(id, ctx);
  maxres[id] = heads[0] ?? 0;
  console.error(`${label} ${id}: client ${String(client)}, maxres HEAD ${maxres[id]}`);
}
writeFileSync(maxresFile, `${JSON.stringify(maxres, null, 2)}\n`);
