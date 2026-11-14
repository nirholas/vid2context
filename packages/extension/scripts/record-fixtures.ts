/**
 * Record the real responses the extension's unit tests replay. Network only;
 * run by hand: `npm run record -w packages/extension`.
 *
 * - Watch pages for a video with captions and one without. Only what the
 *   extension reads is kept: inline scripts other than the player response
 *   are emptied (they carry visitor ids and session config), and the player
 *   response keeps playabilityStatus, videoDetails, captions and microformat
 *   (streamingData and tracking URLs embed the requesting IP address).
 * - The caption track as this network sees it: the srv3 body when YouTube
 *   serves it, or its refusal page when it blocks the network.
 * - With V2C_API set to a running server's /api/v1 base: its /transcript
 *   answer for "Me at the zoo" in the pack format, and its error body for a
 *   video that does not exist.
 *
 * Afterwards every file is checked for IP addresses: anything other than the
 * 0.0.0.0 placeholder YouTube puts in caption URLs stops the run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPlayerResponse, objectAt } from '../src/youtube/player.ts';

const fixtures = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'test', 'fixtures');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const KEEP = ['playabilityStatus', 'videoDetails', 'captions', 'microformat'] as const;
const written: string[] = [];

function save(name: string, body: string): void {
  writeFileSync(join(fixtures, name), body);
  written.push(name);
  console.error(`wrote ${name} (${body.length} bytes)`);
}

function sanitizeWatchPage(html: string, videoId: string): string {
  const player = extractPlayerResponse(html, videoId) as Record<string, unknown> | null;
  if (!player) throw new Error(`No player response for ${videoId} in the page.`);
  const kept = Object.fromEntries(KEEP.filter((k) => k in player).map((k) => [k, player[k]]));
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g, (whole, attrs: string, body: string) => {
    if (!body.trim()) return whole;
    const at = body.indexOf('ytInitialPlayerResponse');
    if (at >= 0) {
      const start = body.indexOf('{', at);
      const json = objectAt(body, start);
      if (json) return `<script${attrs}>var ytInitialPlayerResponse = ${JSON.stringify(kept)};</script>`;
    }
    return `<script${attrs}></script>`;
  });
}

async function watchPage(videoId: string): Promise<string> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`watch ${videoId}: HTTP ${res.status}`);
  return res.text();
}

const zoo = await watchPage('jNQXAC9IVRw');
const zooClean = sanitizeWatchPage(zoo, 'jNQXAC9IVRw');
save('watch-jNQXAC9IVRw.html', zooClean);
save('watch-nocaptions-brXcsLhw84o.html', sanitizeWatchPage(await watchPage('brXcsLhw84o'), 'brXcsLhw84o'));

const en = extractPlayerResponse(zooClean, 'jNQXAC9IVRw')?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.find(
  (t) => t.languageCode === 'en',
);
if (en) {
  const url = new URL(en.baseUrl);
  url.searchParams.set('fmt', 'srv3');
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  const body = await res.text();
  if (res.status === 429) save('timedtext-jNQXAC9IVRw-en-429.html', body);
  else if (res.ok && body.trim()) save('timedtext-jNQXAC9IVRw-en.web.srv3.xml', body);
  else console.error(`timedtext answered HTTP ${res.status} with ${body.length} bytes; not saved`);
}

const api = process.env.V2C_API;
if (api) {
  const ok = await fetch(
    `${api}/transcript?url=${encodeURIComponent('https://www.youtube.com/watch?v=jNQXAC9IVRw')}&format=pack`,
  );
  const okBody = { status: ok.status, contentType: ok.headers.get('content-type'), body: await ok.text() };
  save('api-transcript-pack-jNQXAC9IVRw.json', `${JSON.stringify(okBody, null, 2)}\n`);
  const res = await fetch(`${api}/transcript?url=${encodeURIComponent('https://www.youtube.com/watch?v=xxxxxxxxxxx')}`);
  const errBody = { status: res.status, contentType: res.headers.get('content-type'), body: await res.text() };
  save('api-transcript-not-found.json', `${JSON.stringify(errBody, null, 2)}\n`);
}

const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
const IPV6_PARAM = /ip(?:=|\\u003d|%3D)[0-9a-f]*:[0-9a-f:]+/gi;
for (const name of written) {
  const text = readFileSync(join(fixtures, name), 'utf8');
  const found = [...(text.match(IPV4) ?? []).filter((ip) => ip !== '0.0.0.0'), ...(text.match(IPV6_PARAM) ?? [])];
  if (found.length) throw new Error(`${name} contains IP addresses (${found.join(', ')}); do not commit it.`);
}
console.error('no IP addresses in the recorded files');
