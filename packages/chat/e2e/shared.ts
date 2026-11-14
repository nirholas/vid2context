import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

export const VIDEO_URL = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
export const QUESTION = 'Which engine does the 2000 G500 have, and why do the hosts call it reliable? Cite the moments.';
export const CONTEXT_JSON = fileURLToPath(new URL('../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url));
const SHOTS = fileURLToPath(new URL('../../../docs/guides/chat/', import.meta.url));

export async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENSHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}${name}.png` });
}

export async function ask(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

/** Wait for the answer to finish, then check it cited the video and that a chip opens the embed at its second. */
export async function expectCitedAnswer(page: Page): Promise<void> {
  const answer = page.locator('[data-role=assistant]').last();
  await expect(answer).not.toHaveAttribute('data-status', 'streaming', { timeout: 200_000 });
  await expect(answer).toHaveAttribute('data-status', 'done');
  const chips = answer.locator('[data-cite]');
  await expect(chips.first()).toBeVisible();
  const label = ((await chips.first().textContent()) ?? '').trim();
  const m = /@ (\d+):(\d\d)$/.exec(label);
  expect(m, label).not.toBeNull();
  await chips.first().click();
  const iframe = page.locator('iframe[src*="youtube-nocookie.com/embed/cCPsdFdlshc"]');
  await expect(iframe).toBeVisible();
  const start = Number(new URL((await iframe.getAttribute('src')) ?? '').searchParams.get('start'));
  expect(start).toBe(Number(m?.[1]) * 60 + Number(m?.[2]));
  await expect(page.locator('[data-cited]').first()).toBeVisible();
}
