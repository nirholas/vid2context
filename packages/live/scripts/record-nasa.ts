/**
 * Re-record the NASA live-stream fixtures in test/fixtures/nasa-iss/:
 *
 *   npx tsx packages/live/scripts/record-nasa.ts [videoId]
 *
 * Saves a trimmed ANDROID player response, the master playlist, two
 * successive media playlists of the lowest-bitrate variant and three
 * consecutive media segments that both playlists reference. The requesting
 * machine's IP address, which YouTube embeds in every playlist and segment
 * URL, is replaced with 0.0.0.0 in every saved file. Grep the result for your
 * public IP before committing anyway.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '@vid2context/core';
import { type MediaPlaylist, parsePlaylist, pickAudioUri } from '../src/hls.ts';

const videoId = process.argv[2] ?? 'M3HKLzjvKPc';
const out = join(import.meta.dirname, '../test/fixtures/nasa-iss');
mkdirSync(out, { recursive: true });
const ctx = createContext({ runtime: 'node', env: {} });

const version = '20.10.38';
const playerRes = await ctx.fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'user-agent': `com.google.android.youtube/${version} (Linux; U; Android 11) gzip`,
    'x-youtube-client-name': '3',
    'x-youtube-client-version': version,
  },
  body: JSON.stringify({
    context: { client: { clientName: 'ANDROID', clientVersion: version, androidSdkVersion: 30, hl: 'en' } },
    videoId,
  }),
});
const player = (await playerRes.json()) as {
  playabilityStatus?: { status?: string };
  videoDetails?: Record<string, unknown>;
  streamingData?: { expiresInSeconds?: string; hlsManifestUrl?: string };
};
const hls = player.streamingData?.hlsManifestUrl;
if (!hls) throw new Error(`${videoId} has no hlsManifestUrl (not live?)`);
const ip = /\/ip\/([^/]+)\//.exec(hls)?.[1];
if (!ip) throw new Error('could not find the ip path segment in the manifest URL');
const scrub = (s: string) => s.split(ip).join('0.0.0.0');

const d = player.videoDetails ?? {};
const trimmed = {
  playabilityStatus: { status: player.playabilityStatus?.status },
  videoDetails: {
    videoId: d.videoId,
    title: d.title,
    author: d.author,
    channelId: d.channelId,
    isLive: d.isLive,
    isLiveContent: d.isLiveContent,
  },
  streamingData: { expiresInSeconds: player.streamingData?.expiresInSeconds, hlsManifestUrl: hls },
};
writeFileSync(join(out, `player-${videoId}.json`), `${scrub(JSON.stringify(trimmed, null, 2))}\n`);

const masterText = await (await ctx.fetch(hls)).text();
writeFileSync(join(out, 'master.m3u8'), scrub(masterText));
const master = parsePlaylist(masterText, hls);
if (master.kind !== 'master') throw new Error('expected a master playlist');
const mediaUrl = pickAudioUri(master);
if (!mediaUrl) throw new Error('no audio variant');

const load = async (): Promise<{ text: string; pl: MediaPlaylist }> => {
  const text = await (await ctx.fetch(mediaUrl)).text();
  const pl = parsePlaylist(text, mediaUrl);
  if (pl.kind !== 'media') throw new Error('expected a media playlist');
  return { text, pl };
};

const a = await load();
writeFileSync(join(out, 'media-1.m3u8'), scrub(a.text));
const lastA = a.pl.segments.at(-1);
if (!lastA) throw new Error('empty media playlist');

let b = a;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  b = await load();
  if ((b.pl.segments.at(-1)?.sequence ?? 0) >= lastA.sequence + 2) break;
}
writeFileSync(join(out, 'media-2.m3u8'), scrub(b.text));

for (let seq = lastA.sequence; seq <= lastA.sequence + 2; seq++) {
  const seg = b.pl.segments.find((s) => s.sequence === seq);
  if (!seg) throw new Error(`segment ${seq} missing from the second playlist`);
  const bytes = new Uint8Array(await (await ctx.fetch(seg.uri)).arrayBuffer());
  writeFileSync(join(out, `seg-${seq}.ts`), bytes);
  console.error(`seg-${seq}.ts ${bytes.byteLength} bytes`);
}
console.error(`recorded ${videoId}: media sequences ${a.pl.mediaSequence} and ${b.pl.mediaSequence} into ${out}`);
