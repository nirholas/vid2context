import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const LIVE = !!process.env.LIVE;
const APOLLO = fileURLToPath(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url));

test('decodes and resamples the Apollo clip to 16 kHz mono in the browser', async ({ page }) => {
  // The upload is always refused so no speech-to-text service is called and the view stays on the decode
  // result (with LIVE, a real upload could finish or fail and replace it). The live test below covers the upload.
  await page.route('**/api/v1/uploads', (route) => route.abort('connectionrefused'));
  await page.goto('/app/');
  await page.getByTestId('file-input').setInputFiles(APOLLO);
  const info = page.getByTestId('decode-info');
  await expect(info).toBeVisible({ timeout: 60_000 });
  expect(await info.getAttribute('data-sample-rate')).toBe('16000');
  expect(await info.getAttribute('data-channels')).toBe('1');
  const duration = Number(await info.getAttribute('data-duration-sec'));
  // The source is 24.2 s (tests/fixtures/README.md); MP3 decoders may add up to a frame of padding.
  expect(duration).toBeGreaterThan(24.0);
  expect(duration).toBeLessThan(24.4);
  // The 145 KB MP3 is smaller than the 16 kHz WAV (about 774 KB), so the original is sent.
  expect(await info.getAttribute('data-upload-kind')).toBe('original');
  await expect(info).toContainText('16 kHz mono');
  await expect(page.getByRole('alert')).toContainText('The upload failed');
  await expect(page.getByTestId('error-hint')).toBeVisible();
});

test('rejects a file that is not audio or video with a clear message', async ({ page }) => {
  await page.goto('/app/');
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') });
  const alert = page.getByRole('alert');
  await expect(alert.getByTestId('error-message')).toHaveText('"notes.txt" is not an audio or video file.');
  await expect(alert.getByTestId('error-hint')).toContainText('mp3, m4a, wav');
  await page.getByRole('button', { name: 'Choose another file' }).click();
  await expect(page.getByTestId('drop-zone')).toBeVisible();
});

test.describe('live', () => {
  test.skip(!LIVE, 'set LIVE=1 to transcribe through a speech-to-text service');

  test('uploads the Apollo clip and shows its transcript', async ({ page }) => {
    await page.goto('/app/');
    await page.getByTestId('file-input').setInputFiles(APOLLO);
    await expect(page).toHaveURL(/\?url=upload%3A[0-9a-f]{64}/, { timeout: 60_000 });
    await expect(page.getByTestId('result-title')).toHaveText('apollo11-small-step', { timeout: 150_000 });
    await expect(page.getByTestId('transcript')).toContainText(/one small step/i);
    await expect(page.getByTestId('origin-badge').first()).toContainText('Transcribed by stt/');
    await expect(page.getByTestId('file-list')).toContainText('transcript.srt');
  });
});
