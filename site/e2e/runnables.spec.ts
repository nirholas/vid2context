import { expect, test } from '@playwright/test';

// The runnable examples against a real vid2context server started by playwright.config.ts
// (memory storage, CORS open to the preview origin). Health and formats need no network.
const api = `http://127.0.0.1:${process.env.SITE_E2E_API_PORT}`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((url) => {
    localStorage.setItem('v2c.run.server', JSON.stringify({ mode: 'custom', custom: url }));
  }, api);
});

test('a block shows the recorded response before it runs, then the live one', async ({ page }) => {
  await page.goto('/docs/examples/server/');
  const block = page.locator('#run-health');
  await expect(block.locator('[data-rx-status]')).toHaveText(/^Recorded response: 200 OK/);
  await expect(block.getByRole('button', { name: 'Run' })).toBeEnabled();
  await block.getByRole('button', { name: 'Run' }).click();
  await expect(block.locator('[data-rx-status]')).toHaveText(/^Your run: 200 OK, .*127\.0\.0\.1/);
  await expect(block.locator('[data-rx-body]')).toContainText('"ok": true');
  await expect(block.locator('[data-rx-meta]')).toContainText('x-request-id');
  await block.getByRole('button', { name: 'Show recorded' }).click();
  await expect(block.locator('[data-rx-status]')).toHaveText(/^Recorded response/);
});

test('the server check reports the custom server as online', async ({ page }) => {
  await page.goto('/docs/examples/server/');
  const block = page.locator('#run-formats');
  await expect(block.locator('[data-rx-server]')).toHaveValue('custom');
  await block.locator('[data-rx-server]').selectOption('custom');
  await block.getByRole('button', { name: 'Run' }).click();
  await expect(block.locator('[data-rx-body]')).toContainText('"id": "srt"');
});

test('editing a field rewrites every snippet, and tabs follow the arrow keys', async ({ page }) => {
  await page.goto('/docs/examples/transcripts/');
  const block = page.locator('#run-transcript');
  await block.getByLabel('Video URL').fill('https://youtu.be/MBRqu0YOH14');
  await expect(block.locator('[data-rx-panel="curl"] pre')).toContainText('--data-urlencode url=https://youtu.be/MBRqu0YOH14');
  await expect(block.locator('[data-rx-panel="curl"] pre')).toContainText(api);
  const curl = block.getByRole('tab', { name: 'curl' });
  await curl.focus();
  await page.keyboard.press('ArrowRight');
  await expect(block.getByRole('tab', { name: 'JavaScript' })).toHaveAttribute('aria-selected', 'true');
  await expect(block.locator('[data-rx-panel="fetch"] pre')).toContainText("url: 'https://youtu.be/MBRqu0YOH14'");
  await block.getByRole('tab', { name: 'MCP tool call' }).click();
  await expect(block.locator('[data-rx-panel="mcp"] pre')).toContainText('"name": "get_transcript"');
});

test('a field without a CLI flag hides the CLI tab until it is cleared', async ({ page }) => {
  await page.goto('/docs/examples/transcripts/');
  const block = page.locator('#run-transcript-translate');
  await expect(block.getByRole('tab', { name: 'CLI', includeHidden: true })).toBeHidden();
  await block.getByLabel('Translate').uncheck();
  await expect(block.getByRole('tab', { name: 'CLI' })).toBeVisible();
});

test('an invalid value disables Run and says why; Reset restores the defaults', async ({ page }) => {
  await page.goto('/docs/examples/answers/');
  const block = page.locator('#run-extract-schema');
  await block.getByLabel('JSON Schema').fill('{ not json');
  await expect(block.getByRole('alert')).toContainText('JSON Schema is not valid JSON');
  await expect(block.getByRole('button', { name: 'Run' })).toBeDisabled();
  await block.getByRole('button', { name: 'Reset' }).click();
  await expect(block.getByRole('button', { name: 'Run' })).toBeEnabled();
});

test('an unreachable server explains how to start one with CORS', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('v2c.run.server', JSON.stringify({ mode: 'custom', custom: 'http://127.0.0.1:9' }));
  });
  await page.goto('/docs/examples/server/');
  const block = page.locator('#run-health');
  await block.getByRole('button', { name: 'Run' }).click();
  await expect(block.locator('[data-rx-body]')).toContainText('Could not reach http://127.0.0.1:9');
  await expect(block.locator('[data-rx-body]')).toContainText('VID2CONTEXT_CORS_ORIGINS=');
});

test('the settings dialog validates the URL and keeps the key out of the snippets', async ({ page }) => {
  await page.goto('/docs/examples/server/');
  const block = page.locator('#run-models');
  await block.getByRole('button', { name: 'Server URL and API key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Where examples run' });
  await dialog.getByLabel('Server URL').fill('not a url');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a full URL');
  await dialog.getByLabel('Server URL').fill(api);
  await dialog.getByLabel('API key (optional)').fill('secret-key-value-123');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const curl = block.locator('[data-rx-panel="curl"] pre');
  await expect(curl).toContainText('Authorization: Bearer $VID2CONTEXT_API_KEY');
  await expect(curl).not.toContainText('secret-key-value-123');
});

test('pages without examples load no runnable script', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(r.url());
  });
  await page.goto('/docs/architecture/');
  expect(scripts.filter((s) => s.includes('RunnableRuntime'))).toEqual([]);
});
