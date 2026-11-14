/**
 * Browser check: serves demo/ with Vite and transcribes the Apollo clip in
 * headless Chromium on WASM (headless Chromium usually has no WebGPU adapter).
 * Gated by LIVE=1: the first run downloads the model from huggingface.co and
 * the ONNX Runtime WASM files from cdn.jsdelivr.net.
 */
import { fileURLToPath } from 'node:url';
import type { Segment } from '@vid2context/core';
import { type Browser, chromium } from 'playwright';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const demo = fileURLToPath(new URL('../demo/', import.meta.url));
const apollo = fileURLToPath(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url));

describe.skipIf(!process.env.LIVE)('live: demo page in headless Chromium', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    const { createServer } = await import('vite');
    const port = 20000 + Math.floor(Math.random() * 10000);
    server = await createServer({ configFile: `${demo}vite.config.mjs`, server: { port, strictPort: true, host: '127.0.0.1' } });
    await server.listen();
    base = `http://127.0.0.1:${port}/`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('transcribes the Apollo clip with WASM', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => document.getElementById('status')?.dataset.webgpu !== undefined);
    const webgpu = await page.locator('#status').getAttribute('data-webgpu');
    console.error(`[stt-transformers browser test] headless Chromium WebGPU adapter: ${webgpu}`);
    await page.setInputFiles('#file', apollo);
    await page.selectOption('#device', 'wasm');
    await page.click('#run');
    await page.waitForFunction(() => ['done', 'error'].includes(document.getElementById('status')?.dataset.state ?? ''), null, {
      timeout: 280_000,
    });
    const status = page.locator('#status');
    expect(await status.textContent()).not.toMatch(/^Error/);
    expect(await status.getAttribute('data-device')).toBe('wasm');
    expect(await status.getAttribute('data-language')).toBe('en');
    const segments = JSON.parse((await status.getAttribute('data-result')) ?? '[]') as Segment[];
    expect(segments.map((s) => s.text).join(' ')).toMatch(/small step/i);
    let prev = 0;
    for (const s of segments) {
      expect(s.startSec).toBeGreaterThanOrEqual(prev);
      expect(s.endSec).toBeGreaterThanOrEqual(s.startSec);
      prev = s.endSec;
    }
    console.error(`[stt-transformers browser test] ${await status.textContent()}`);
    expect(errors).toEqual([]);
  }, 300_000);
});
