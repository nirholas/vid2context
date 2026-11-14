/**
 * Re-record the CLI's own fixtures from the real services:
 *
 *   LIVE=1 npx tsx packages/cli/test/record-fixtures.ts
 *
 * Writes packages/cli/test/fixtures/playlist-gwagon.json: every request
 * `vid2context list <playlist>` made (endpoint, body without the client
 * `context` block) with its trimmed response. Trimming follows
 * providers/youtube/test/fixtures/browse/README.md so nothing tied to the
 * recording machine (visitor ids, IP-bearing URLs, tracking) is kept. The
 * script refuses to write when the result still contains this machine's
 * public IP address.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, expandInput, Registry } from '@vid2context/core';
import youtube from '@vid2context/provider-youtube';

if (!process.env.LIVE) {
  console.error('Set LIVE=1 to record from the real services.');
  process.exit(2);
}

export const PLAYLIST = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';

const DROP_TOP = new Set(['responseContext', 'topbar', 'frameworkUpdates', 'trackingParams', 'sidebar']);
const DROP_ANY = new Set([
  'watchEndpointSupportedOnesieConfig',
  'trackingParams',
  'clickTrackingParams',
  'loggingDirectives',
  'loggingContext',
  'serviceTrackingParams',
  'menu',
  'menuButton',
  'menuOnTap',
  'thumbnailOverlays',
  'accessibility',
  'accessibilityData',
  'thumbnail',
  'thumbnails',
  'avatar',
  'badges',
]);

function trim(value: unknown, top = false): unknown {
  if (Array.isArray(value)) return value.map((v) => trim(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if ((top && DROP_TOP.has(k)) || DROP_ANY.has(k)) continue;
      out[k] = trim(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email redacted]')
      .replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => (/\d{4}-\d{2}-\d{2}/.test(m) ? m : '[phone redacted]'));
  }
  return value;
}

interface Recorded {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  status: number;
  response: unknown;
}

const recorded: Recorded[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const res = await fetch(input, init);
  const text = await res.clone().text();
  let body: Record<string, unknown> | undefined;
  if (typeof init?.body === 'string') {
    const { context: _context, ...rest } = JSON.parse(init.body) as Record<string, unknown>;
    body = rest;
  }
  recorded.push({ method: init?.method ?? 'GET', url, body, status: res.status, response: trim(JSON.parse(text), true) });
  return res;
};

const ctx = createContext({ runtime: 'node', env: {}, fetch: recordingFetch });
const refs = await expandInput(new Registry([youtube].flat(), 'node'), PLAYLIST, ctx, { limit: 3 });
console.error(`listed ${refs.length} refs: ${refs.map((r) => r.nativeId).join(', ')}`);

const json = `${JSON.stringify(recorded, null, 2)}\n`;
const ip = (await (await fetch('https://api.ipify.org')).text()).trim();
if (ip && json.includes(ip)) {
  console.error('The recording still contains this machine\'s public IP address; not writing it.');
  process.exit(1);
}
const file = join(import.meta.dirname, 'fixtures', 'playlist-gwagon.json');
writeFileSync(file, json);
console.error(`wrote ${file} (${json.length} bytes, ${recorded.length} requests)`);
