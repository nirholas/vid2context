import { expect, test } from '@playwright/test';
import { ask, CONTEXT_JSON, expectCitedAnswer, QUESTION, shot } from './shared.ts';

test.skip(!process.env.LIVE, 'calls real keyless LLM services; set LIVE=1');

test('client-only: a dropped VideoContext JSON grounds a streamed, cited answer', async ({ page }) => {
  await page.goto('/chat/');
  await expect(page.getByText('Client-only').first()).toBeVisible();
  await shot(page, 'workspace-empty');

  await page.getByRole('button', { name: 'Attach context' }).first().click();
  await page.getByRole('tab', { name: /JSON files/ }).click();
  await page.locator('input[type=file]').setInputFiles(CONTEXT_JSON);
  await expect(page.locator('[data-context="youtube:cCPsdFdlshc"]')).toBeVisible();

  // Prefer OVH gpt-oss (non-strict, so the chain can still fall back).
  await page.getByRole('button', { name: /Change model/ }).click();
  await expect(page.getByRole('listbox', { name: 'Models' })).toBeVisible();
  await shot(page, 'model-picker');
  await page.getByRole('combobox').fill('gpt-oss ovh');
  await page.getByRole('combobox').press('Enter');
  await expect(page.getByRole('button', { name: /Change model/ })).toHaveAttribute('aria-label', /gpt-oss-120b/);

  await ask(page, QUESTION);
  await expectCitedAnswer(page);
  await shot(page, 'citation-panel');
});
