/**
 * Getting the transcript another way when the server is blocked by YouTube:
 * paste it, upload a subtitle file, transcribe a media file or audio the
 * server downloaded, or build it in the browser without an API.
 *
 * GET /context answers with the real `blocked` error this repo's server gave
 * on a GCP VM (fixtures/README.md), so the error panel is the real one. The
 * import itself goes to the real local API server; its metadata lookup
 * reaches YouTube when the network allows and falls back to the link
 * otherwise, so the title is only checked under LIVE=1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const LIVE = !!process.env.LIVE;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const VIDEO = 'https://www.youtube.com/watch?v=xAcTmDO6NTI';
const BLOCKED = readFileSync(new URL('./fixtures/context-blocked-xAcTmDO6NTI.json', import.meta.url), 'utf8');
// The real text copied from the video's "Show transcript" panel (packages/imports/test/fixtures/README.md).
const COPIED = readFileSync(new URL('../../imports/test/fixtures/youtube-transcript-xAcTmDO6NTI.txt', import.meta.url), 'utf8');
const FIRST_LINE = 'ANA BELL: All right, so welcome to the first lecture of 6.100L.';
const APOLLO = fileURLToPath(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url));
// "Me at the zoo", 19 s: short enough for a real server download in the live test.
const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

/** Only GET /context is answered with the recorded block; every other route reaches the real local server. */
async function blockedRun(page: Page, video = VIDEO) {
  await page.route(
    (u) => u.pathname.endsWith('/api/v1/context') && u.searchParams.get('url') === video,
    (route) => route.fulfill({ status: 503, contentType: 'application/json', body: BLOCKED }),
  );
  await page.goto(`/app/?url=${encodeURIComponent(video)}`);
  // A failed run shows the recovery panel; the error itself is under "Technical details".
  const panel = page.getByTestId('recovery-panel');
  await expect(panel).toHaveAttribute('data-error-code', 'blocked');
  await panel.getByText('Technical details').click();
  await expect(panel.getByTestId('error-message')).toContainText('YouTube blocked this server');
  await expect(panel.getByTestId('recovery-details')).toContainText('Error code blocked');
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
  await expect(panel.getByRole('tab')).toHaveText([
    'From my browser',
    'Video or audio file',
    'Server download',
    'Paste',
    'Subtitle file',
  ]);
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
  await panel.getByRole('tab', { name: 'Subtitle file' }).click();
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

test('a video or audio file is decoded here, and a failed server upload points to transcribing on this device', async ({
  page,
}) => {
  // The upload is refused so no speech-to-text service is called; the decode in the browser runs in full.
  await page.route('**/api/v1/uploads', (route) => route.abort('connectionrefused'));
  const panel = await blockedRun(page);
  await panel.getByRole('tab', { name: 'Video or audio file' }).click();
  await expect(panel.getByTestId('media-where-browser')).toBeChecked();
  await panel.getByText("Don't have the file?").click();
  await expect(panel.getByTestId('ytdlp-command')).toHaveText(
    'yt-dlp -f "bestaudio[ext=m4a]/bestaudio" -o "%(title)s [%(id)s].%(ext)s" "https://www.youtube.com/watch?v=xAcTmDO6NTI"',
  );
  await panel.getByTestId('media-where-server').check();
  await panel.getByTestId('media-file-input').setInputFiles(APOLLO);
  const error = panel.getByTestId('import-error');
  await expect(error).toContainText('Could not reach the vid2context API', { timeout: 60_000 });
  await expect(error).toContainText('Or pick "On this device" to transcribe in this browser instead');
  const results = await new AxeBuilder({ page }).include('[data-testid="import-panel"]').withTags(WCAG).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test('the server download tab says what this server allows', async ({ page }) => {
  const panel = await blockedRun(page);
  await panel.getByRole('tab', { name: 'Server download' }).click();
  // The local server offers downloads when yt-dlp and ffmpeg are there, and says why not otherwise.
  const on = panel.getByTestId('server-download');
  const off = panel.getByTestId('server-download-off');
  await expect(on.or(off)).toBeVisible();
  if (await on.isVisible()) {
    await expect(on).toContainText('stays on the server for');
    await expect(panel.getByTestId('server-download-start')).toBeEnabled();
  } else {
    await expect(off).toContainText('does not download media');
  }
});

test.describe('live media', () => {
  test.skip(!LIVE, 'set LIVE=1 to download the Whisper model and media for real');

  test('the Apollo clip transcribed in this browser becomes the transcript of the link', async ({ page }) => {
    const panel = await blockedRun(page);
    await panel.getByRole('tab', { name: 'Video or audio file' }).click();
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/v1/imports') && r.method() === 'POST', {
      timeout: 170_000,
    });
    await panel.getByTestId('media-file-input').setInputFiles(APOLLO);
    const body = (await posted).postDataJSON() as { url: string; via: string; transcriber: string; segments: unknown[] };
    expect(body).toMatchObject({ url: VIDEO, via: 'media', transcriber: expect.stringMatching(/^stt\/transformers\//) });
    await expect(page.getByTestId('transcript')).toContainText(/small step/i, { timeout: 60_000 });
    await expect(page.getByTestId('origin-badge').first()).toContainText('Imported transcript');
  });

  test('the server downloads the audio, and this browser transcribes it', async ({ page }) => {
    const panel = await blockedRun(page, ZOO);
    await panel.getByRole('tab', { name: 'Server download' }).click();
    await panel.getByTestId('server-download-start').click();
    await expect(panel.getByTestId('server-download-done')).toBeVisible({ timeout: 120_000 });
    await expect(panel.getByRole('link', { name: 'Save to my device' })).toHaveAttribute(
      'href',
      /\/downloads\/[0-9a-f-]+\/file$/,
    );
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/v1/imports') && r.method() === 'POST', {
      timeout: 170_000,
    });
    await panel.getByTestId('server-download-transcribe').click();
    expect((await posted).postDataJSON()).toMatchObject({ url: ZOO, via: 'media' });
    await expect(page.getByTestId('result-title')).toHaveText('Me at the zoo', { timeout: 60_000 });
    await expect(page.getByTestId('transcript')).toContainText(/elephant/i);
  });
});
