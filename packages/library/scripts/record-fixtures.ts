/**
 * Records the real YouTube responses the library tests replay.
 *
 *   npx tsx packages/library/scripts/record-fixtures.ts
 *
 * Runs the real pipeline (YouTube provider only) against a public playlist,
 * its first videos and one id that does not exist, through a fetch wrapper
 * that keeps every request and response. Player responses are trimmed to the
 * fields the provider reads; anything that embeds the caller's IP address
 * (streamingData, tracking) is dropped, and the run fails if the public IP
 * still appears anywhere.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, expandInput, getVideoContext, Registry } from '@vid2context/core';
import youtube from '@vid2context/provider-youtube';
import { type FixtureCall, requestKey } from '../test/replay.ts';

const PLAYLIST = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
/** Already recorded with working captions in test/fixtures (copied from providers/youtube/test/fixtures). */
const SKIP = new Set(['youtube:cCPsdFdlshc']);
const MISSING = 'xxxxxxxxxxx';
const OUT = join(import.meta.dirname, '..', 'test', 'fixtures', 'youtube-gwagon-playlist.json');

const DROP_PLAYER_FIELDS = [
  'streamingData',
  'playbackTracking',
  'responseContext',
  'playerConfig',
  'storyboards',
  'adPlacements',
  'playerAds',
  'annotations',
  'attestation',
  'frameworkUpdates',
  'trackingParams',
  'heartbeatParams',
  'adBreakHeartbeatParams',
  'endscreen',
  'cards',
];

/** Dropped from every innertube response: request echo and tracking, which carry the caller's IP. */
const DROP_INNERTUBE_FIELDS = ['responseContext', 'trackingParams', 'frameworkUpdates'];

/** Remove every property whose string value is a googlevideo.com media URL: those embed the caller's IP. */
function scrubMedia(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubMedia);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string' && x.includes('googlevideo.com')) continue;
    out[k] = scrubMedia(x);
  }
  return out;
}

/** People's contact details in video descriptions never land in the repo. */
function redact(body: string): string {
  return body
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email redacted]')
    .replace(/(?<!\d)\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g, '[phone redacted]');
}

function trim(url: string, body: string): string {
  if (!url.includes('/youtubei/v1/')) return body;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const drop = url.includes('/youtubei/v1/player') ? DROP_PLAYER_FIELDS : DROP_INNERTUBE_FIELDS;
    for (const k of drop) delete json[k];
    return JSON.stringify(scrubMedia(json));
  } catch {
    return body;
  }
}

const quiet = {
  debug() {},
  info() {},
  warn: (msg: string, data?: unknown) => console.error(msg, JSON.stringify(data ?? {})),
  error: (msg: string, data?: unknown) => console.error(msg, JSON.stringify(data ?? {})),
};

async function main(): Promise<void> {
  const ip = (await (await fetch('https://api.ipify.org')).text()).trim();
  const calls: FixtureCall[] = [];
  const recording: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const reqBody = init?.body === undefined || init.body === null ? '' : String(init.body);
    const res = await fetch(req);
    const text = await res.text();
    calls.push({
      method: req.method,
      url: req.url,
      key: requestKey(req.url, reqBody),
      status: res.status,
      contentType: res.headers.get('content-type') ?? undefined,
      body: redact(trim(req.url, text)),
    });
    return new Response(text, { status: res.status, headers: res.headers });
  };
  const ctx = createContext({ runtime: 'node', env: { YOUTUBE_BLOCK_COOLDOWN_SEC: '0' }, fetch: recording, log: quiet });
  const registry = new Registry(youtube, 'node');

  const refs = await expandInput(registry, PLAYLIST, ctx, { limit: 200 });
  console.error(`playlist: ${refs.length} videos`);
  for (const ref of refs.filter((r) => !SKIP.has(r.id))) {
    try {
      const c = await getVideoContext(registry, ref.url ?? ref.input, {}, ctx);
      console.error(`  ${ref.id}: ${c.metadata.title} (${c.transcript.origin}, ${c.transcript.segments.length} segments)`);
    } catch (err) {
      console.error(`  ${ref.id}: ${(err as Error).message}`);
    }
  }
  await getVideoContext(registry, MISSING, {}, ctx).catch((err: Error) => console.error(`  ${MISSING}: ${err.message}`));

  const out = JSON.stringify({ recordedAt: new Date().toISOString(), playlist: PLAYLIST, calls }, null, 1);
  for (const c of calls) if (ip && (c.body.includes(ip) || c.url.includes(ip))) console.error('IP in', c.method, c.url.slice(0, 120), c.body.includes(ip) ? `body: ...${c.body.slice(Math.max(0, c.body.indexOf(ip) - 200), c.body.indexOf(ip) + 40).replaceAll(ip, '<IP>')}` : 'url');
  if (ip && out.includes(ip)) throw new Error('the recording still contains this machine’s public IP; not writing it');
  writeFileSync(OUT, `${out}\n`);
  console.error(`wrote ${calls.length} calls to ${OUT}`);
}

await main();
