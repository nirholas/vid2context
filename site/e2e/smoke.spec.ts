import { expect, test } from '@playwright/test';

test('the hero input sends the link to /app/?url=<encoded>', async ({ page }) => {
  // The app is a separate build (prompt 47); answer its URL so navigation can complete.
  await page.route('**/app/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title>' }),
  );
  await page.goto('/');
  const link = 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s';
  await page.getByLabel('Video link').fill(link);
  await page.getByRole('button', { name: 'Get context' }).click();
  await page.waitForURL('**/app/**');
  const url = new URL(page.url());
  expect(url.pathname).toBe('/app/');
  expect(url.search).toBe(`?url=${encodeURIComponent(link)}`);
});

test('an empty hero input shows an error instead of navigating', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Get context' }).click();
  await expect(page.getByRole('alert')).toHaveText('Paste a video link first.');
  expect(new URL(page.url()).pathname).toBe('/');
});

test('the theme toggle persists across reloads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  const toggle = page.locator('[data-theme-toggle]');
  await expect(toggle).toHaveAttribute('data-current', 'dark');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('v2c.theme'))).toBe('light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');
});

test('the 404 page renders for an unknown path', async ({ page }) => {
  const res = await page.goto('/no-such-page/');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing at this timestamp');
});

test('the demo viewer switches files with the keyboard', async ({ page }) => {
  await page.goto('/#demo');
  const tab = page.getByRole('tab', { name: /context\.md/ });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await tab.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: /transcript\.srt/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('00:00:01,');
});

test('docs pages render with a sidebar and working copy buttons', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/clients/claude-code/');
  await expect(page.getByRole('heading', { level: 1, name: 'Use vid2context in Claude Code', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Docs pages' }).getByRole('link', { name: 'Claude Code' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const block = page.locator('.prose .code').first();
  const copy = block.locator('[data-copy-btn]');
  await copy.click();
  await expect(copy).toHaveText('Copied');
  // innerText, because that is what the copy button puts on the clipboard.
  // biome-ignore lint/performance/useDomNodeTextContent: compares against the copy button's innerText
  const expected = (await block.locator('pre').innerText()).trim();
  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(expected);
  expect(expected).toMatch(/claude mcp add|git clone/);
});
