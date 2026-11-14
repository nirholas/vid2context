/**
 * Live: loads dist/chrome unpacked into Chromium, opens a real YouTube watch
 * page, clicks "Copy for AI" and reads the clipboard. Needs LIVE=1, a build
 * (`npm run build -w packages/extension`) and a network YouTube serves
 * captions to (datacenter IPs often get HTTP 429 for caption requests).
 *
 * The second test loads the same real page but answers the caption request
 * with the track recorded from youtube.com (test/fixtures), so the in-browser
 * path (track choice, parsing, agent prompt, clipboard) is checked even on a
 * network YouTube refuses captions to. Set V2C_SCREENSHOTS to a folder to
 * save screenshots of the buttons, popup and options page.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, expect, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '..', 'dist', 'chrome');
const shots = process.env.V2C_SCREENSHOTS;
const WATCH = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

test.skip(!process.env.LIVE, 'live test: set LIVE=1');

let context: BrowserContext;
let profile: string;

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'v2c-ext-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    locale: 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
});

test.afterAll(async () => {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
});

test('the extension loads its service worker', async () => {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
});

async function copyOnWatchPage(): Promise<string> {
  const page = await context.newPage();
  await page.goto(WATCH, { waitUntil: 'domcontentloaded' });
  const host = page.locator('#vid2context-actions');
  const copy = host.getByRole('button', { name: 'Copy for AI' });
  await expect(copy).toBeVisible({ timeout: 30_000 });
  await expect(host.getByRole('button', { name: 'Download .zip' })).toBeVisible();
  await expect(host.getByRole('button', { name: 'Open in vid2context' })).toBeVisible();

  // A navigation event must not add a second button group.
  await page.evaluate(() => document.dispatchEvent(new Event('yt-navigate-finish')));
  await expect(page.locator('#vid2context-actions')).toHaveCount(1);

  await copy.click();
  const status = host.getByRole('status');
  await expect(status).toBeVisible({ timeout: 30_000 });
  const statusText = (await status.textContent()) ?? '';
  expect(statusText, `status after clicking: ${statusText}`).toMatch(/^Copied/);

  if (shots) await host.screenshot({ path: join(shots, 'buttons.png') });
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  await page.close();
  return clip;
}

function expectTranscript(clip: string): void {
  expect(clip).toContain('Below is context for one video, "Me at the zoo"');
  expect(clip).toMatch(/\[0:0\d\]\(https:\/\/www\.youtube\.com\/watch\?v=jNQXAC9IVRw&t=\ds\)/);
  expect(clip.toLowerCase()).toContain('elephants');
}

test('Copy for AI on a watch page copies the timestamped transcript', async () => {
  expectTranscript(await copyOnWatchPage());
});

test('Copy for AI with the recorded caption track served for the caption request', async () => {
  const srv3 = readFileSync(resolve(here, '..', 'test', 'fixtures', 'timedtext-jNQXAC9IVRw-en.srv3.xml'), 'utf8');
  await context.route(/\/api\/timedtext\?(?:.*&)?v=jNQXAC9IVRw(?:&|$)/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/xml; charset=UTF-8', body: srv3 }),
  );
  try {
    const clip = await copyOnWatchPage();
    expectTranscript(clip);
    expect(clip).toContain(
      '[0:01](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s) All right, so here we are, in front of the elephants',
    );
  } finally {
    await context.unrouteAll();
  }
});

test('popup and options pages render', async () => {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // URL.origin is "null" for chrome-extension: in Node, so take scheme and host directly.
  const base = /^chrome-extension:\/\/[a-p]{32}/.exec(worker.url())?.[0];
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 560 });
  await popup.goto(`${base}/popup/index.html`);
  await expect(popup.locator('header').getByText('vid2context', { exact: true })).toBeVisible();
  await expect(popup.getByRole('heading', { name: 'Recent' })).toBeVisible();
  if (shots) await popup.screenshot({ path: join(shots, 'popup.png') });
  const options = await context.newPage();
  await options.goto(`${base}/options/index.html`);
  await expect(options.getByLabel('App base')).toHaveValue('https://vid2context.com');
  await expect(options.getByLabel('API base')).toHaveValue('http://localhost:8787/api/v1');
  await expect(options.getByLabel('Default copy format')).toHaveValue('agent');
  if (shots) await options.screenshot({ path: join(shots, 'options.png'), fullPage: true });
});
