/**
 * Live: the web app bridge end to end. Loads dist/chrome unpacked into
 * Chromium, serves a page on http://localhost (one of the bridge's built-in
 * origins) and talks to bridge.js with window.postMessage the way the web app
 * does (docs/contracts/transcript-import.md). Needs LIVE=1 and a build
 * (`npm run build -w packages/extension`).
 *
 * The transcript tests reach the real YouTube. From a network YouTube refuses
 * captions to (datacenter IPs get HTTP 429 on timedtext), the live result is
 * an error, which the test accepts as long as it is one well-formed result.
 * The last test answers caption requests with the track recorded from
 * youtube.com (test/fixtures), so the success path is checked anywhere.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '..', 'dist', 'chrome');
const ZOO = 'jNQXAC9IVRw';

test.skip(!process.env.LIVE, 'live test: set LIVE=1');

// The page records every message the extension posts, the way the web app listens for them.
const PAGE = `<!doctype html><meta charset="utf-8"><title>bridge test</title>
<script>
  window.v2c = [];
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.source === 'vid2context-extension') window.v2c.push(e.data);
  });
</script>
<p>vid2context bridge test page</p>`;

// A frame on another origin that tries to talk to the bridge in its parent.
const FRAME = `<!doctype html><meta charset="utf-8"><script>
  parent.postMessage({ source: 'vid2context-web', type: 'ping', id: 'from-frame' }, '*');
  parent.postMessage({ source: 'vid2context-web', type: 'youtube-transcript', id: 'frame-request', videoId: '${ZOO}' }, '*');
</script>`;

interface Msg {
  source: string;
  type: string;
  id?: string;
  version?: string;
  capabilities?: string[];
  stage?: string;
  message?: string;
  ok?: boolean;
  transcript?: { language: string; kind: string; segments: { startSec: number; endSec: number; text: string }[] };
  metadata?: { title?: string };
  error?: { code: string; message: string; hint?: string };
}

let context: BrowserContext;
let profile: string;
let server: Server;
let base: string;
let otherOrigin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const body = req.url === '/frame' ? FRAME : PAGE;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  base = `http://localhost:${port}`;
  // 127.0.0.1 is a different origin from localhost, though both run the bridge.
  otherOrigin = `http://127.0.0.1:${port}`;
  profile = mkdtempSync(join(tmpdir(), 'v2c-bridge-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    locale: 'en-US',
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  if (!context.serviceWorkers()[0]) await context.waitForEvent('serviceworker');
});

test.afterAll(async () => {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
  await new Promise((r) => server.close(r));
});

async function openPage(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(base);
  return page;
}

const messages = (page: Page) => page.evaluate(() => (window as unknown as { v2c: Msg[] }).v2c);

async function send(page: Page, data: Record<string, unknown>): Promise<void> {
  await page.evaluate((d) => window.postMessage({ source: 'vid2context-web', ...d }, location.origin), data);
}

async function waitForResult(page: Page, id: string, timeout: number): Promise<{ result: Msg; progress: Msg[] }> {
  await page.waitForFunction(
    (rid) => (window as unknown as { v2c: Msg[] }).v2c.some((m) => m.type === 'youtube-transcript:result' && m.id === rid),
    id,
    { timeout, polling: 250 },
  );
  const all = (await messages(page)).filter((m) => m.id === id);
  const results = all.filter((m) => m.type === 'youtube-transcript:result');
  expect(results, 'exactly one result').toHaveLength(1);
  return { result: results[0] as Msg, progress: all.filter((m) => m.type === 'progress') };
}

function youtubeTabs(): string[] {
  return context
    .pages()
    .map((p) => p.url())
    .filter((u) => u.includes('youtube.com/watch'));
}

test('posts a pong on load and answers ping with pong', async () => {
  const page = await openPage();
  await expect.poll(async () => (await messages(page)).find((m) => m.type === 'pong' && m.id === undefined)).toBeTruthy();
  const started = Date.now();
  await send(page, { type: 'ping', id: 'p1' });
  await page.waitForFunction(
    () => (window as unknown as { v2c: Msg[] }).v2c.some((m) => m.type === 'pong' && m.id === 'p1'),
    null,
    {
      timeout: 800,
    },
  );
  console.error(`pong after ${Date.now() - started} ms`);
  const pong = (await messages(page)).find((m) => m.id === 'p1');
  expect(pong).toEqual({
    source: 'vid2context-extension',
    type: 'pong',
    id: 'p1',
    version: '0.1.0',
    capabilities: ['youtube-transcript'],
  });
  await page.close();
});

test('ignores messages from a frame on another origin', async () => {
  const page = await openPage();
  await page.evaluate((src) => {
    const f = document.createElement('iframe');
    f.src = src;
    document.body.append(f);
  }, `${otherOrigin}/frame`);
  await page.waitForTimeout(2000);
  const ids = (await messages(page)).map((m) => m.id);
  expect(ids).not.toContain('from-frame');
  expect(ids).not.toContain('frame-request');
  expect(youtubeTabs()).toEqual([]);
  await page.close();
});

test('answers a bad video id with bad-request', async () => {
  const page = await openPage();
  await send(page, { type: 'youtube-transcript', id: 'bad', videoId: 'not-an-id' });
  const { result, progress } = await waitForResult(page, 'bad', 2000);
  expect(progress).toEqual([]);
  expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } });
  await page.close();
});

// Runs before the live request: a real 429 there opens the provider's breaker in the service worker for 10 minutes.
test('with the recorded caption track served, the direct path returns the transcript', async () => {
  test.setTimeout(120_000);
  const srv3 = readFileSync(resolve(here, '..', 'test', 'fixtures', 'timedtext-jNQXAC9IVRw-en.srv3.xml'), 'utf8');
  await context.route(/\/api\/timedtext\?(?:.*&)?v=jNQXAC9IVRw(?:&|$)/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/xml; charset=UTF-8', body: srv3 }),
  );
  try {
    const page = await openPage();
    await send(page, { type: 'youtube-transcript', id: 'recorded', videoId: ZOO, language: 'en' });
    const { result, progress } = await waitForResult(page, 'recorded', 95_000);
    console.error(`progress: ${progress.map((p) => p.stage).join(', ')}`);
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    // Real innertube player call from the service worker (through the Origin rule), recorded caption track.
    expect(progress.map((p) => p.stage)).toEqual(['player', 'captions']);
    expect(result.transcript).toMatchObject({ language: 'en', kind: 'creator-captions' });
    expect(result.transcript?.segments[0]).toEqual({
      startSec: 1.2,
      endSec: 3.36,
      text: 'All right, so here we are, in front of the elephants',
    });
    expect(result.metadata).toEqual({ title: 'Me at the zoo', channel: 'jawed', durationSec: 19 });
    expect(youtubeTabs()).toEqual([]);
    await page.close();
  } finally {
    await context.unrouteAll();
  }
});

test('a youtube-transcript request returns one result from the real YouTube', async () => {
  test.setTimeout(120_000);
  const page = await openPage();
  const started = Date.now();
  await send(page, { type: 'youtube-transcript', id: 'live', videoId: ZOO });
  const { result, progress } = await waitForResult(page, 'live', 95_000);
  console.error(`live result after ${Math.round((Date.now() - started) / 1000)} s`);
  console.error(`progress: ${progress.map((p) => `${p.stage}: ${p.message}`).join(' | ')}`);
  console.error(
    `result: ${JSON.stringify(result.ok ? { ...result, transcript: { ...result.transcript, segments: result.transcript?.segments.length } } : result)}`,
  );
  expect(progress[0]?.stage).toBe('player');
  // innertube answered the background's player call: the Origin rule works (without it YouTube sends HTTP 403).
  expect(
    progress.map((p) => p.stage),
    'the direct player call returned caption tracks',
  ).toContain('captions');
  if (result.ok) {
    expect(result.transcript?.segments.length).toBeGreaterThan(0);
    expect(result.metadata?.title).toBe('Me at the zoo');
  } else {
    // The direct download failed, so the background YouTube tab must have had its turn.
    expect(progress.map((p) => p.stage)).toContain('tab');
    expect(['not-found', 'unavailable', 'no-captions', 'blocked', 'timeout']).toContain(result.error?.code);
    expect(result.error?.hint).toBeTruthy();
  }
  expect(youtubeTabs(), 'the background YouTube tab is closed').toEqual([]);
  await page.close();
});
