import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const LIVE = !!process.env.LIVE;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

for (const theme of ['dark', 'light'] as const) {
  test(`home is complete and accessible in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('v2c.theme', t), theme);
    await page.goto('/app/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Any video, as context for your AI');
    await expect(page.getByRole('textbox', { name: 'Video link' })).toHaveAttribute(
      'placeholder',
      'Paste a YouTube, Vimeo, TikTok, podcast or any video link',
    );
    await expect(page.getByRole('button', { name: /Get context/ })).toBeVisible();
    await expect(page.getByTestId('drop-zone')).toContainText('or drop a video or audio file');
    await expect(page.getByRole('button', { name: 'Me at the zoo (0:19)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
    await expect(page.getByTestId('api-status')).toHaveAttribute('data-status', 'online');
    await page.getByRole('button', { name: 'Mode: Auto' }).click();
    await expect(page.getByRole('radio', { name: /Captions only/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Include comments' })).toHaveAttribute('aria-pressed', 'false');
    await expectAccessible(page);
  });
}

test('home works at 360 px without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/app/');
  await expect(page.getByRole('textbox', { name: 'Video link' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(page.getByRole('link', { name: 'vid2context' })).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeFocused();
});

test('Ctrl+K opens search over saved results', async ({ page }) => {
  await page.goto('/app/');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('searchbox', { name: 'Search saved results' })).toBeFocused();
  await expect(page.getByRole('dialog')).toContainText('Nothing saved yet');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('searchbox', { name: 'Search saved results' })).toBeHidden();
});

test('everything on home is reachable by keyboard', async ({ page }) => {
  await page.goto('/app/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Video link' }).focus();
  for (const name of [
    'Mode: Auto',
    'Language: automatic',
    'Include comments',
    'Timestamps in transcript.txt',
    'Attach a video or audio file',
    'Get context',
  ]) {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('drop-zone')).toBeFocused();
});

test('an input no source understands shows the message, the hint and a retry', async ({ page }) => {
  await page.goto(`/app/?url=${encodeURIComponent('not a video')}`);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Could not get context for this link');
  await expect(alert.getByTestId('error-message')).toHaveText('No source understands "not a video".');
  await expect(alert.getByTestId('error-hint')).toContainText('Pass a video URL');
  await expect(alert).toContainText('Error code unsupported-input');
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expectAccessible(page);
});

test('settings: an unreachable API base switches to client-only mode and back', async ({ page }) => {
  await page.goto('/app/?view=settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('Keys are stored in this browser')).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('API base').fill('http://127.0.0.1:9/api/v1');
  await page.getByRole('button', { name: 'Save and test' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not reach the vid2context API at http://127.0.0.1:9/api/v1.');
  await page.goto('/app/');
  await expect(page.getByTestId('client-only-banner')).toContainText('No API answered at http://127.0.0.1:9/api/v1.');
  await page.goto(`/app/?url=${encodeURIComponent('https://www.youtube.com/watch?v=jNQXAC9IVRw')}`);
  await expect(page.getByRole('heading', { name: 'Links need an API server' })).toBeVisible();
  await page.goto('/app/?view=settings');
  await page.getByLabel('API base').fill('');
  await page.getByRole('button', { name: 'Save and test' }).click();
  await expect(page.getByText(/Connected: vid2context/)).toBeVisible();
});

test('provider keys are saved in IndexedDB v2c-settings and come back', async ({ page }) => {
  await page.goto('/app/?view=settings');
  await page.getByLabel('Name 1').fill('TRANSFORMERS_STT_MODEL');
  await page.getByLabel('Value 1').fill('whisper-tiny');
  await page.getByRole('button', { name: 'Save keys' }).click();
  await expect(page.getByText('Saved 1 value.')).toBeVisible();
  const stored = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('v2c-settings', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const get = req.result.transaction('kv').objectStore('kv').get('providerKeys');
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
      }),
  );
  expect(stored).toEqual({ TRANSFORMERS_STT_MODEL: 'whisper-tiny' });
  await page.reload();
  await expect(page.getByLabel('Value 1')).toHaveValue('whisper-tiny');
});

test.describe('live', () => {
  test.skip(!LIVE, 'set LIVE=1 to fetch from YouTube');

  test('paste a YouTube link, get every file, copy and download', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('textbox', { name: 'Video link' }).fill('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await page.getByRole('textbox', { name: 'Video link' }).press('Enter');
    await expect(page).toHaveURL(/\?url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DjNQXAC9IVRw/);
    await expect(page.getByTestId('result-title')).toHaveText('Me at the zoo', { timeout: 150_000 });
    const files = page.getByTestId('file-list').getByRole('button');
    await expect(files.first()).toContainText('context.md');
    for (const name of ['transcript.md', 'transcript.txt', 'transcript.srt', 'transcript.vtt', 'context.json', 'metadata.json']) {
      await expect(page.getByTestId('file-list')).toContainText(name);
    }

    await page
      .getByTestId('file-list')
      .getByRole('button', { name: /transcript\.srt/ })
      .click();
    await expect(page.getByTestId('file-content')).toContainText('-->');
    const [srt] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download transcript.srt' }).click(),
    ]);
    expect(srt.suggestedFilename()).toBe('transcript.srt');

    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('-->');

    const zipButton = page.getByTestId('download-zip');
    await expect(zipButton).toHaveText(/Download \.zip \(\d+ files\)/);
    const [zip] = await Promise.all([page.waitForEvent('download'), zipButton.click()]);
    expect(zip.suggestedFilename()).toBe('me-at-the-zoo.zip');

    await page.getByRole('button', { name: 'Copy for agents' }).click();
    const agent = await page.evaluate(() => navigator.clipboard.readText());
    expect(agent).toContain('# Video context');
    expect(agent).toContain('Me at the zoo');

    await expect(page.getByRole('link', { name: 'Open in chat' })).toHaveAttribute(
      'href',
      `/chat/?input=${encodeURIComponent('https://www.youtube.com/watch?v=jNQXAC9IVRw')}`,
    );
    await page.getByRole('tab', { name: /How we got this/ }).click();
    await expect(page.getByRole('list', { name: 'Steps tried, in order' })).toBeVisible();
    await page.getByRole('tab', { name: /Transcript/ }).click();
    await expect(page.getByTestId('transcript').getByRole('link').first()).toHaveAttribute(
      'href',
      /youtube\.com\/watch\?v=jNQXAC9IVRw&t=\d+s/,
    );
    await expectAccessible(page);

    await page.goto('/app/');
    await expect(page.getByTestId('recent-list')).toContainText('Me at the zoo');
  });

  test('/app/?url=https://youtu.be/jNQXAC9IVRw opens straight to the result', async ({ page }) => {
    await page.goto('/app/?url=https://youtu.be/jNQXAC9IVRw');
    await expect(page.getByTestId('result-title')).toHaveText('Me at the zoo', { timeout: 150_000 });
    await expect(page.getByTestId('file-list')).toContainText('context.md');
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  });

  test('a missing video shows the error, its hint and what was tried', async ({ page }) => {
    await page.goto(`/app/?url=${encodeURIComponent('https://www.youtube.com/watch?v=xxxxxxxxxxx')}`);
    const alert = page.getByRole('alert');
    await expect(alert.getByTestId('error-message')).toContainText('This video is unavailable', { timeout: 60_000 });
    await expect(alert.getByTestId('error-hint')).toBeVisible();
    await expect(alert.getByText(/What was tried \(\d+\)/)).toBeVisible();
  });
});
