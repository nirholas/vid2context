/**
 * Getting the transcript another way when the server is blocked by YouTube:
 * paste it, upload a subtitle file, or build it in the browser without an API.
 *
 * GET /context answers with the real `blocked` error this repo's server gave
 * on a GCP VM (fixtures/README.md), so the error panel is the real one. The
 * import itself goes to the real local API server; its metadata lookup
 * reaches YouTube when the network allows and falls back to the link
 * otherwise, so the title is only checked under LIVE=1.
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const LIVE = !!process.env.LIVE;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const VIDEO = 'https://www.youtube.com/watch?v=xAcTmDO6NTI';
const BLOCKED = readFileSync(new URL('./fixtures/context-blocked-xAcTmDO6NTI.json', import.meta.url), 'utf8');
// The real text copied from the video's "Show transcript" panel (packages/imports/test/fixtures/README.md).
const COPIED = readFileSync(new URL('../../imports/test/fixtures/youtube-transcript-xAcTmDO6NTI.txt', import.meta.url), 'utf8');
const FIRST_LINE = 'ANA BELL: All right, so welcome to the first lecture of 6.100L.';

async function blockedRun(page: Page) {
  await page.route('**/api/v1/context?*', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: BLOCKED }),
  );
  await page.goto(`/app/?url=${encodeURIComponent(VIDEO)}`);
  const alert = page.getByRole('alert').first();
  await expect(alert.getByTestId('error-message')).toContainText('YouTube blocked this server');
  await expect(alert).toContainText('Error code blocked');
  return page.getByTestId('import-panel');
}

async function expectImported(page: Page, saved: 'true' | 'false') {
  await expect(page.getByTestId('result-title')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('origin-badge').first()).toContainText('Imported transcript');
  await expect(page.getByTestId('transcript')).toContainText(FIRST_LINE);
  await expect(page.getByTestId('imported-notice')).toHaveAttribute('data-saved', saved);
  await expect(page.getByTestId('file-list')).toContainText('transcript.srt');
  if (LIVE)
    await expect(page.getByTestId('result-title')).toHaveText('Lecture 1: Introduction to CS and Programming Using Python');
}

test('a blocked YouTube run offers the other ways, and says how to install the extension when it is missing', async ({
  page,
}) => {
  const panel = await blockedRun(page);
  await expect(panel.getByRole('heading', { name: 'Get the transcript another way' })).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'From my browser' })).toHaveAttribute('aria-selected', 'true');
  // No extension in this browser: no pong within 800 ms.
  await expect(panel.getByTestId('extension-missing')).toContainText('not installed in this browser');
  await expect(panel.getByTestId('extension-missing')).toContainText('npm run build -w packages/extension');
  const results = await new AxeBuilder({ page }).include('[data-testid="import-panel"]').withTags(WCAG).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test('paste the "Show transcript" text and get the full result, kept in history', async ({ page }) => {
  const panel = await blockedRun(page);
  await panel.getByRole('tab', { name: 'Paste' }).click();
  await panel.getByTestId('import-text').fill(COPIED);
  const posted = page.waitForRequest((r) => r.url().endsWith('/api/v1/imports') && r.method() === 'POST');
  await panel.getByTestId('import-paste').click();
  const body = (await posted).postDataJSON() as { url: string; text: string; via: string };
  expect(body).toMatchObject({ url: VIDEO, via: 'paste' });
  expect(body.text).toBe(COPIED);
  // The local server has storage and is not hosted, so it saved the import.
  await expectImported(page, 'true');

  // Reopening the link shows it from this browser's history, even though the server is still "blocked".
  await page.reload();
  await expect(page.getByTestId('transcript')).toContainText(FIRST_LINE);
  await expect(page.getByTestId('origin-badge').first()).toContainText('Imported transcript');
});

test('upload a subtitle file', async ({ page }) => {
  const panel = await blockedRun(page);
  await panel.getByRole('tab', { name: 'Upload a file' }).click();
  const posted = page.waitForRequest((r) => r.url().endsWith('/api/v1/imports') && r.method() === 'POST');
  await panel
    .getByTestId('import-file-input')
    .setInputFiles({ name: 'lecture-1.en.txt', mimeType: 'text/plain', buffer: Buffer.from(COPIED) });
  expect((await posted).postDataJSON()).toMatchObject({ url: VIDEO, via: 'file', filename: 'lecture-1.en.txt' });
  await expectImported(page, 'true');
});

test('a malformed paste shows why, with the accepted formats', async ({ page }) => {
  const panel = await blockedRun(page);
  await panel.getByRole('tab', { name: 'Paste' }).click();
  await panel.getByTestId('import-text').fill('<html><body>not a transcript</body></html>');
  await panel.getByTestId('import-paste').click();
  await expect(panel.getByTestId('import-error')).toContainText('Nothing could be read');
  await expect(panel.getByTestId('import-error')).toContainText('WebVTT (.vtt), SRT (.srt)');
});

test('without an API, the transcript is built in the browser', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('v2c.apiBase', 'http://127.0.0.1:9/api/v1'));
  await page.goto(`/app/?url=${encodeURIComponent(VIDEO)}`);
  await expect(page.getByRole('heading', { name: 'Links need an API server' })).toBeVisible();
  const panel = page.getByTestId('import-panel');
  await panel.getByRole('tab', { name: 'Paste' }).click();
  await panel.getByTestId('import-text').fill(COPIED);
  await panel.getByTestId('import-paste').click();
  await expect(page.getByTestId('result-title')).toHaveText(VIDEO, { timeout: 60_000 });
  await expect(page.getByTestId('transcript')).toContainText(FIRST_LINE);
  await expect(page.getByTestId('imported-notice')).toContainText('built here in your browser');
});
