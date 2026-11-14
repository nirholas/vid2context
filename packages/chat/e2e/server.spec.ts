import { expect, test } from '@playwright/test';
import { ask, expectCitedAnswer, QUESTION, shot, VIDEO_URL } from './shared.ts';

test.skip(!process.env.LIVE, 'starts a local server that fetches YouTube and calls real LLMs; set LIVE=1');

test('server mode: the ?input= hand-off attaches the video and /api/v1/chat answers with citations', async ({ page }) => {
  await page.goto(`/chat/?input=${encodeURIComponent(VIDEO_URL)}`);
  const chip = page.locator('[data-context]').first();
  await expect(chip).toContainText('Best & Worst G-Wagon Years', { timeout: 90_000 });
  await expect(page.getByText('Client-only')).toHaveCount(0);
  await expect(page).not.toHaveURL(/input=/);

  await ask(page, QUESTION);
  await expectCitedAnswer(page);
  await shot(page, 'server-mode-answer');
});
