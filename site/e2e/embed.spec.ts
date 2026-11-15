import { expect, type Page, test } from '@playwright/test';

// The embed widget (/embed/), the loader (/embed.js) and the builder and demos in /docs/embed/.
// Samples are the recorded contexts the site serves, so these tests need no network. The API
// test uses the real server playwright.config.ts starts (CORS open to the preview origin).
const api = `http://127.0.0.1:${process.env.SITE_E2E_API_PORT}`;

/** A host page on another origin (about:blank) that embeds the widget and records every message it posts. */
async function host(page: Page, baseURL: string, body: string): Promise<void> {
  await page.setContent(
    `<!doctype html><html><body>${body.replaceAll('BASE', baseURL)}<script>window.msgs=[];addEventListener('message',e=>{if(e.data&&e.data.source==='vid2context')msgs.push(e.data)})</script></body></html>`,
  );
}

const messages = (page: Page) => page.evaluate(() => (window as unknown as { msgs: { type: string; [k: string]: unknown }[] }).msgs);

test('the transcript view renders a sample, searches it and switches to chapters', async ({ page }) => {
  await page.goto('/embed/?sample=zoo');
  const w = page.locator('#w');
  await expect(w).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('heading', { name: 'Me at the zoo' })).toBeVisible();
  await expect(page.locator('.w-line')).toHaveCount(6);
  await expect(page.locator('.w-count')).toHaveText('6 lines');
  await page.getByRole('searchbox', { name: 'Search the transcript' }).fill('trunks');
  await expect(page.locator('.w-count')).toHaveText('1 of 6');
  await expect(page.locator('mark')).toHaveText('trunks');
  await page.getByRole('tab', { name: 'Chapters (3)' }).click();
  await expect(page.locator('.w-line')).toHaveCount(3);
  await expect(page.locator('.w-line').first()).toContainText('Intro');
  // Timestamps link to the moment on YouTube.
  await expect(page.locator('a.w-ts').nth(1)).toHaveAttribute('href', 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s');
});

test('theme, accent, compact and a time range come from the address', async ({ page }) => {
  await page.goto('/embed/?sample=gwagon&theme=light&accent=3b82f6&compact=1&start=60&end=2m&header=0&branding=0');
  await expect(page.locator('#w')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--w-accent'))).toBe('#3b82f6');
  await expect(page.locator('#w')).toHaveClass(/compact/);
  await expect(page.locator('.w-head')).toHaveCount(0);
  await expect(page.locator('.w-credit')).toHaveCount(0);
  const starts = await page.locator('.w-line').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-start'))));
  expect(starts.length).toBeGreaterThan(5);
  expect(Math.min(...starts)).toBeGreaterThanOrEqual(55);
  expect(Math.max(...starts)).toBeLessThan(120);
});

test('quote, card and link box views', async ({ page }) => {
  await page.goto('/embed/?sample=zoo&view=quote&start=0:05&end=0:13');
  await expect(page.locator('blockquote')).toHaveText(/the cool thing about these guys.*really really long trunks/);
  await expect(page.locator('figcaption a')).toHaveAttribute('href', /t=5s$/);

  await page.goto('/embed/?sample=zoo&view=card');
  await expect(page.locator('.w-card img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg');
  await expect(page.getByRole('link', { name: 'Read the transcript' })).toHaveAttribute('href', /\/app\/\?url=https%3A%2F%2Fwww\.youtube\.com/);

  await page.goto('/embed/?view=input');
  const form = page.locator('form.w-form');
  await expect(form).toHaveAttribute('action', /\/app\/$/);
  await expect(form.getByRole('textbox', { name: 'Turn a video into context for AI' })).toBeVisible();
});

test('bad parameters and a missing source show an error instead of a blank frame', async ({ page }) => {
  await page.goto('/embed/?sample=zoo&view=everything');
  await expect(page.getByRole('alert')).toContainText('View must be one of');
  await expect(page.getByRole('alert')).toContainText('bad_param');
  await page.goto('/embed/');
  await expect(page.getByRole('alert')).toContainText('No video to show.');
});

test('a url goes to the API and its error is shown with the hint', async ({ page }) => {
  await page.goto(`/embed/?url=${encodeURIComponent('https://example.invalid/not-a-video')}&api=${encodeURIComponent(api)}`);
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#w')).toHaveAttribute('data-state', 'error');
  await expect(alert.locator('code')).not.toHaveText('network');
  await expect(alert.getByRole('link', { name: 'Try it in the vid2context app' })).toBeVisible();
});

test('the downloads are real transcript files', async ({ page }) => {
  await page.goto('/embed/?sample=zoo');
  const [srt] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download SRT' }).click()]);
  expect(srt.suggestedFilename()).toBe('Me-at-the-zoo.srt');
  const text = await (await srt.createReadStream()).toArray();
  expect(Buffer.concat(text).toString()).toMatch(/^1\n00:00:01,200 --> 00:00:03,360\nAll right, so here we are/);
});

test('an iframe posts ready, loaded, resize and segment, and obeys commands from its parent', async ({ page, baseURL }) => {
  await host(page, baseURL ?? '', '<iframe id="f" src="BASE/embed/?sample=zoo" style="width:600px;height:400px"></iframe>');
  await expect.poll(async () => (await messages(page)).map((m) => m.type)).toEqual(expect.arrayContaining(['ready', 'loaded', 'resize']));
  const loaded = (await messages(page)).find((m) => m.type === 'loaded');
  expect(loaded).toMatchObject({ title: 'Me at the zoo', segments: 6, chapters: 3, origin: 'creator-captions' });

  const frame = page.frameLocator('#f');
  await frame.locator('.w-tx').nth(2).click();
  await expect.poll(async () => (await messages(page)).find((m) => m.type === 'segment')).toMatchObject({ text: 'really really long trunks' });

  const origin = new URL(baseURL ?? '').origin;
  await page.evaluate((o) => {
    const f = document.getElementById('f') as HTMLIFrameElement;
    f.contentWindow?.postMessage({ target: 'vid2context', type: 'search', query: 'elephants' }, o);
    f.contentWindow?.postMessage({ target: 'vid2context', type: 'theme', theme: 'light' }, o);
  }, origin);
  await expect(frame.locator('.w-count')).toHaveText('1 of 6');
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.evaluate((o) => {
    const f = document.getElementById('f') as HTMLIFrameElement;
    f.contentWindow?.postMessage({ target: 'vid2context', type: 'search', query: '' }, o);
    f.contentWindow?.postMessage({ target: 'vid2context', type: 'seek', sec: 8 }, o);
  }, origin);
  await expect(frame.locator('.w-line[aria-current="true"]')).toContainText('really really long trunks');
});

test('<vid2context-embed> sizes itself, re-dispatches events and has methods', async ({ page, baseURL }) => {
  await host(
    page,
    baseURL ?? '',
    `<script src="BASE/embed.js"></script>
     <vid2context-embed id="e" sample="zoo" view="quote" start="5" end="13" loading="eager"></vid2context-embed>
     <vid2context-embed id="t" sample="gwagon" max-height="300" loading="eager"></vid2context-embed>
     <script>window.events=[];for(const id of ['e','t'])for(const t of ['loaded','search','segment','resize'])document.getElementById(id).addEventListener('vid2context:'+t,ev=>events.push({id,t,d:ev.detail}))</script>`,
  );
  const events = () => page.evaluate(() => (window as unknown as { events: { id: string; t: string; d: Record<string, unknown> }[] }).events);
  await expect.poll(async () => (await events()).filter((e) => e.t === 'loaded').length).toBe(2);
  expect(await page.evaluate(() => typeof (window as unknown as { Vid2Context?: { embed: unknown } }).Vid2Context?.embed)).toBe('function');

  // The quote grows to its content; the transcript stops at max-height and scrolls inside.
  const height = (id: string) => page.evaluate((i) => document.getElementById(i)?.shadowRoot?.querySelector('iframe')?.getBoundingClientRect().height ?? 0, id);
  await expect.poll(() => height('e')).toBeLessThan(260);
  await expect.poll(() => height('t')).toBe(300);

  await page.evaluate(() => (document.getElementById('t') as unknown as { search(q: string): void }).search('engine'));
  await expect.poll(async () => (await events()).find((e) => e.id === 't' && e.t === 'search' && e.d.query === 'engine')?.d.matches).toBeGreaterThan(0);

  // Changing an attribute reloads the widget with the new option.
  await page.evaluate(() => document.getElementById('e')?.setAttribute('view', 'chapters'));
  await expect.poll(async () => (await events()).filter((e) => e.id === 'e' && e.t === 'loaded').length).toBe(2);
});

test('the builder updates the preview, the snippets and the hash, and logs events', async ({ page }) => {
  await page.goto('/docs/embed/');
  const builder = page.locator('[data-widget="embed-builder"]');
  await expect(builder).toHaveAttribute('data-ready', 'true');
  const preview = page.frameLocator('[data-eb-frame]');
  await expect(preview.locator('#w')).toHaveAttribute('data-state', 'ready');
  await expect(builder.locator('[data-eb-log]')).toContainText('loaded');

  await builder.getByLabel('View', { exact: true }).selectOption('quote');
  await builder.getByLabel('Start (seconds)').fill('0:05');
  await builder.getByLabel('End (seconds)').fill('0:13');
  await expect(builder.locator('[data-eb-out="iframe"]')).toContainText('view=quote&amp;start=5&amp;end=13'.replaceAll('&amp;', '&'));
  await expect(page.locator('[data-eb-frame]')).toHaveAttribute('src', /view=quote/);
  await expect(preview.locator('blockquote')).toContainText('really really long trunks');
  await expect(page).toHaveURL(/#embed=.*view%3Dquote/);

  await builder.getByRole('tab', { name: 'Web component' }).click();
  await expect(builder.locator('[data-eb-out="component"]')).toContainText('view="quote"');
  await builder.getByRole('tab', { name: 'Web component' }).press('ArrowRight');
  await expect(builder.getByRole('tab', { name: 'JavaScript' })).toHaveAttribute('aria-selected', 'true');

  await builder.getByLabel('Accent color').fill('red;}');
  await expect(builder.locator('[data-eb-error]')).toContainText('hex color');
  await builder.getByLabel('Accent color').fill('3b82f6');
  await expect(builder.locator('[data-eb-error]')).toBeHidden();

  // A shared link restores the setup.
  await page.reload();
  await expect(builder.getByLabel('View', { exact: true })).toHaveValue('quote');
  await expect(builder.getByLabel('Accent color')).toHaveValue('3b82f6');

  // The drive buttons send real commands.
  await builder.locator('[data-preset="transcript"]').click();
  await expect(preview.locator('.w-search')).toBeVisible();
  await builder.locator('[data-eb-cmd="search"]').click();
  await expect(preview.locator('.w-count')).toHaveText('1 of 6');
  await expect(builder.locator('[data-eb-log]')).toContainText('"query":"elephants"');
});

test('the gallery and the live element run on their docs pages', async ({ page }) => {
  await page.goto('/docs/embed/');
  const gallery = page.locator('iframe[data-eb-auto]');
  await expect(gallery).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    await gallery.nth(i).scrollIntoViewIfNeeded();
    await expect(page.frameLocator(`iframe[data-eb-auto] >> nth=${i}`).locator('#w')).toHaveAttribute('data-state', 'ready');
  }

  await page.goto('/docs/embed/javascript/');
  const demo = page.locator('[data-widget="embed-component"]');
  await expect(demo).toHaveAttribute('data-ready', 'true');
  await expect(demo.locator('[data-ec-log]')).toContainText('vid2context:loaded');
  await demo.getByRole('button', { name: "search('engine')" }).click();
  await expect(demo.locator('[data-ec-log]')).toContainText('"query":"engine"');
  await demo.getByRole('button', { name: "load({ sample: 'zoo' })" }).click();
  await expect(demo.locator('[data-ec-log]')).toContainText('Me at the zoo');
});

test('pages without embed blocks load no embed script', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(r.url());
  });
  await page.goto('/docs/providers/');
  expect(scripts.some((s) => s.includes('embed'))).toBe(false);
});
