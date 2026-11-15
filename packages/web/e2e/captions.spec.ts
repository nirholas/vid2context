/**
 * The Captions page in a real browser. Without LIVE the caption routes are
 * answered with responses recorded from the real API (test/fixtures/README.md,
 * captions-*), so the page, the preview and the saved files are real while
 * YouTube is never asked. With LIVE=1 the local server answers for real.
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const LIVE = !!process.env.LIVE;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

interface Recorded {
  request: { method: string; path: string };
  status: number;
  contentType: string;
  body: unknown;
}
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8')) as Recorded;

/** Serve each recorded response at the API path it was recorded from, query included. */
async function replay(page: Page, ...names: string[]) {
  for (const name of names) {
    const r = fixture(name);
    const [path, query = ''] = r.request.path.split('?');
    const want = new URLSearchParams(query);
    await page.route(
      (u) =>
        u.pathname.endsWith(`/api/v1${path}`) &&
        [...want].every(([k, v]) => u.searchParams.get(k) === v) &&
        [...u.searchParams.keys()].every((k) => want.has(k)),
      (route) =>
        route.fulfill({
          status: r.status,
          contentType: r.contentType,
          body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
        }),
    );
  }
}

test('lists the tracks, previews one and saves a track and a translation as files', async ({ page }) => {
  test.skip(LIVE, 'the live variant below asks the real server');
  await replay(
    page,
    'captions-formats.json',
    'captions-languages-jNQXAC9IVRw.json',
    'captions-metadata-jNQXAC9IVRw.json',
    'captions-transcript-en-srt.json',
    'captions-transcript-de-vtt.json',
    'captions-transcript-fr-translate.json',
  );
  await page.goto('/app/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Captions' }).click();
  await expect(page.getByRole('heading', { name: 'Captions', level: 1 })).toBeVisible();
  await page.getByRole('textbox').first().fill(ZOO);
  await page.getByRole('button', { name: 'Find captions' }).click();
  await expect(page).toHaveURL(/\?view=captions&url=/);
  await expect(page.getByTestId('captions-title')).toHaveText('Me at the zoo');
  const rows = page.getByTestId('captions-tracks').getByRole('listitem');
  await expect(rows).toHaveCount(2);

  // Save the English track as SubRip: a real file named after the title and language.
  const saved = page.waitForEvent('download');
  await rows
    .nth(0)
    .getByRole('button', { name: /Save srt/ })
    .click();
  const file = await saved;
  expect(file.suggestedFilename()).toBe('Me at the zoo.en.srt');
  expect(readFileSync(await file.path(), 'utf8')).toBe(fixture('captions-transcript-en-srt.json').body);

  // Preview the German track as WebVTT.
  await page.getByTestId('captions-format').selectOption('vtt');
  await rows.nth(1).getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('captions-preview')).toContainText('Also hier sind wir vor den Elefanten.');

  // Translate into French: the server keeps every timing.
  await page.getByTestId('captions-format').selectOption('srt');
  await page.getByTestId('captions-target').fill('fr');
  const translated = page.waitForEvent('download');
  await page.getByTestId('captions-translate').click();
  const fr = await translated;
  expect(fr.suggestedFilename()).toBe('Me at the zoo.fr.translated.srt');
  expect(readFileSync(await fr.path(), 'utf8')).toContain('Alors nous voici devant les éléphants.');

  const results = await new AxeBuilder({ page }).include('main').withTags(WCAG).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test('a result links to the captions of its video', async ({ page }) => {
  await page.route(
    (u) => u.pathname.endsWith('/api/v1/context') && u.searchParams.get('url') === ZOO,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture('context-jNQXAC9IVRw.json').body),
      }),
  );
  await page.goto(`/app/?url=${encodeURIComponent(ZOO)}`);
  const link = page.getByTestId('result-captions-link');
  await expect(link).toBeVisible({ timeout: 60_000 });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`\\?view=captions&url=${encodeURIComponent(ZOO).replace(/[.?]/g, '\\$&')}`));
});

test.describe('live', () => {
  test.skip(!LIVE, 'set LIVE=1 to list and save captions through the real server');

  test('saves every track of a real video as one .zip, listing any the platform refused', async ({ page }) => {
    await page.goto(`/app/?view=captions&url=${encodeURIComponent(ZOO)}`);
    await expect(page.getByTestId('captions-title')).toHaveText('Me at the zoo', { timeout: 60_000 });
    const languages = await page
      .getByTestId('captions-tracks')
      .getByRole('listitem')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-language') ?? ''));
    expect(languages).toEqual(expect.arrayContaining(['en', 'de']));
    const saved = page.waitForEvent('download', { timeout: 120_000 }).then((d) => ({ zip: d }));
    const refused = page
      .getByRole('alert')
      .filter({ hasText: 'No track could be fetched' })
      .waitFor({ timeout: 120_000 })
      .then(() => ({ zip: undefined }));
    await page.getByTestId('captions-save-all').click();
    const { zip } = await Promise.race([saved, refused]);
    if (!zip) {
      // YouTube refused every track (it blocks this IP for a while after too many requests). The page must say so
      // with the block's own code and hint, never a generic "reload the page".
      test.info().annotations.push({ type: 'platform-block', description: 'YouTube refused every caption track' });
      const alert = page.getByRole('alert');
      await expect(alert.getByTestId('error-code')).toHaveText(/^(blocked|rate-limited)$/);
      await expect(alert.getByTestId('error-hint')).not.toContainText('browser console');
      return;
    }
    expect(zip.suggestedFilename()).toBe('Me at the zoo.zip');
    const raw = readFileSync(await zip.path()).toString('latin1');
    expect(raw.startsWith('PK')).toBe(true);
    // YouTube rate-limits caption requests from many servers: every track is either in the .zip or named as not fetched.
    const missing = languages.filter((l) => !raw.includes(`Me at the zoo.${l}.srt`));
    if (missing.length > 0) {
      await expect(page.getByTestId('captions-failures')).toBeVisible();
      expect(missing.length).toBeLessThan(languages.length);
    }
  });
});
