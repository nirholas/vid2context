import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

// The library playground: @vid2context/core in a Web Worker on the built page, against
// the real fixtures. The API case uses the server playwright.config.ts starts.
const api = `http://127.0.0.1:${process.env.SITE_E2E_API_PORT}`;
const PATH = '/docs/examples/playground/';
const fixture = (id: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../../tests/fixtures/contexts', `${id}.json`), 'utf8')) as {
    metadata: { title: string };
    transcript: { segments: unknown[] };
  };

const pg = (page: Page) => page.locator('[data-pg]');
const opOut = (page: Page) => page.locator('[data-pg-output="op"]');
const opStatus = (page: Page) => page.locator('[data-pg-status="op"]');
const snipOut = (page: Page) => page.locator('[data-pg-output="snippet"]');
const snipStatus = (page: Page) => page.locator('[data-pg-status="snippet"]');

async function open(page: Page, hash = ''): Promise<void> {
  await page.goto(`${PATH}${hash}`);
  // The worker answered once the status shows a timing.
  await expect(opStatus(page)).toHaveText(/ ms$/);
}

test('picking a fixture renders it with core', async ({ page }) => {
  await open(page);
  const big = fixture('youtube-cCPsdFdlshc');
  await pg(page).getByLabel('Fixture', { exact: true }).selectOption('youtube-cCPsdFdlshc');
  await expect(page.locator('[data-pg-summary]')).toContainText(
    `${big.metadata.title}: ${big.transcript.segments.length} segments`,
  );
  await pg(page).getByLabel('Format', { exact: true }).selectOption('json');
  await expect(page.locator('[data-pg-call]')).toHaveText("return core.render(context, 'json');");
  await expect(opOut(page)).toContainText(`"title": ${JSON.stringify(big.metadata.title)}`);
  await expect(opStatus(page)).toHaveText(/^json: [\d,]+ characters, about [\d,]+ tokens, \d+ ms$/);
});

test('changing a format option updates the output and the code', async ({ page }) => {
  await open(page);
  const before = await opOut(page).textContent();
  await pg(page).getByLabel('Line length').fill('12');
  await expect(page.locator('[data-pg-call]')).toHaveText("return core.render(context, 'srt', { maxLineChars: 12 });");
  await expect(opOut(page)).not.toHaveText(before ?? '');
  const text = (await opOut(page).textContent()) ?? '';
  const cueLines = text.split('\n').filter((l) => l && !/^\d+$/.test(l) && !l.includes('-->'));
  expect(cueLines.length).toBeGreaterThan(0);
  for (const l of cueLines) expect(l.length).toBeLessThanOrEqual(12);

  // Options that a format does not read are hidden; text shows its offset only with timestamps.
  await pg(page).getByLabel('Format', { exact: true }).selectOption('text');
  await expect(pg(page).getByLabel('Line length')).toBeHidden();
  await expect(pg(page).getByLabel('Offset (seconds)')).toBeHidden();
  await pg(page).getByLabel('Timestamps', { exact: true }).check();
  await expect(pg(page).getByLabel('Offset (seconds)')).toBeVisible();
  await expect(opOut(page)).toContainText('[0:01] All right, so here we are');
});

test('the code box runs a snippet in a worker, away from the page', async ({ page }) => {
  await open(page);
  const code = pg(page).getByRole('textbox', { name: 'Your code' });
  await code.fill('console.log(typeof document);\nreturn Object.keys(core.formatters);');
  await pg(page).getByRole('button', { name: 'Run' }).click();
  await expect(snipStatus(page)).toHaveText(/^Result \(JSON\): /);
  await expect(snipOut(page)).toContainText('undefined');
  await expect(snipOut(page)).toContainText('"srt"');

  await pg(page).getByLabel('Starter').selectOption('search');
  await expect(snipOut(page)).toContainText('segments match');

  // Edit as code: the operation's own code runs in the code box and gives the same output.
  await pg(page).getByRole('button', { name: 'Edit as code' }).click();
  await expect(code).toHaveValue("return core.render(context, 'srt');\n");
  await expect(snipStatus(page)).toHaveText(/^Result \(text\): /);
  expect(await snipOut(page).textContent()).toBe(await opOut(page).textContent());
});

test('a thrown error is shown with its code and hint', async ({ page }) => {
  await open(page);
  const code = pg(page).getByRole('textbox', { name: 'Your code' });
  await code.fill("throw new Error('boom');");
  await code.press('Control+Enter');
  await expect(snipStatus(page)).toHaveText('Error: Error');
  await expect(snipOut(page)).toHaveText('Error: boom');
  await expect(snipOut(page)).toHaveClass(/pg-is-error/);

  await code.fill("return core.render(context, 'docx');");
  await code.press('Control+Enter');
  await expect(snipOut(page)).toContainText('Vid2ContextError (bad-request): Unknown format "docx".');
  await expect(snipOut(page)).toContainText('hint: Available formats: text, json');

  // An operation core refuses shows the same way.
  await pg(page).getByLabel('Operation', { exact: true }).selectOption('chunk');
  await pg(page).getByLabel('Tokens per chunk').fill('10');
  await pg(page).getByLabel('Overlap (tokens)').fill('20');
  await expect(opOut(page)).toContainText('overlapTokens (20) must be smaller than maxTokens (10).');
});

test('a snippet that never ends is stopped', async ({ page }) => {
  await open(page);
  await pg(page).getByRole('textbox', { name: 'Your code' }).fill('while (true) {}');
  await pg(page).getByRole('button', { name: 'Run' }).click();
  await expect(snipOut(page)).toContainText('Stopped after 5 seconds', { timeout: 10_000 });
  await pg(page).getByRole('textbox', { name: 'Your code' }).fill('return 1 + 1;');
  await pg(page).getByRole('button', { name: 'Run' }).click();
  await expect(snipOut(page)).toHaveText('2');
});

test('the hash round-trips the options and the code', async ({ page, context }) => {
  await open(page);
  await pg(page).getByLabel('Format', { exact: true }).selectOption('vtt');
  await pg(page).getByLabel('Lines per cue').fill('1');
  await pg(page).getByLabel('Chapter').selectOption('1');
  await pg(page).getByRole('textbox', { name: 'Your code' }).fill('return context.metadata.title.toUpperCase();');
  await expect(page).toHaveURL(/#pg:.*format=vtt/);
  const url = page.url();
  expect(url).toContain('maxLines=1');
  expect(url).toContain('chapter=1');
  await expect(page.locator('[data-pg-call]')).toHaveText(
    "context = core.getSection(context, { chapter: 1 });\nreturn core.render(context, 'vtt', { maxLines: 1 });",
  );
  await expect(opStatus(page)).toHaveText(/^vtt: /);
  const output = await opOut(page).textContent();

  const other = await context.newPage();
  await other.goto(url);
  await expect(other.locator('[data-pg-call]')).toHaveText(
    "context = core.getSection(context, { chapter: 1 });\nreturn core.render(context, 'vtt', { maxLines: 1 });",
  );
  await expect(other.getByLabel('Chapter')).toHaveValue('1');
  await expect(opOut(other)).toHaveText(output ?? '');
  // A shared link runs its code too.
  await expect(snipOut(other)).toHaveText('ME AT THE ZOO');
});

test('an API error is shown in the {error:{code,message,hint}} shape', async ({ page }) => {
  await open(page);
  await pg(page).getByRole('radio', { name: 'From the API' }).check();
  await pg(page).getByLabel('Server URL (optional)').fill(api);
  await pg(page).getByLabel('Video URL').fill('not a video');
  await pg(page).getByRole('button', { name: 'Fetch' }).click();
  const err = page.locator('[data-pg-source-error]');
  await expect(err).toBeVisible();
  await expect(err).toHaveText(/^HTTP 4\d\d\n[a-z-]+: .+/);
  await expect(page.locator('[data-pg-summary]')).toHaveText('No context loaded.');
});

test('pasted JSON is checked and then used', async ({ page }) => {
  await open(page);
  await pg(page).getByRole('radio', { name: 'Paste JSON' }).check();
  await expect(page.locator('[data-pg-summary]')).toContainText('Paste a VideoContext');
  const box = pg(page).getByLabel('VideoContext JSON');
  await box.fill('{"metadata": {}}');
  await expect(page.locator('[data-pg-source-error]')).toHaveText('metadata.title must be a string.');
  await pg(page).getByRole('button', { name: 'Start from the fixture' }).click();
  await expect(page.locator('[data-pg-source-error]')).toBeHidden();
  await expect(page.locator('[data-pg-summary]')).toContainText('Me at the zoo: 6 segments');
});

test('pages without the playground do not load it', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (/playground/i.test(r.url())) scripts.push(r.url());
  });
  await page.goto('/docs/examples/transcripts/');
  await page.goto('/');
  expect(scripts).toEqual([]);
});
