/**
 * Browser checks against demo/ in headless Chromium, gated by LIVE=1.
 * Chromium is launched with a software WebGPU adapter (SwiftShader), so
 * WebLLM can run without a GPU, slowly. What each environment supported is
 * printed to stderr so the run documents itself.
 */
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserAiSupport } from '../src/detect.ts';
import { smallestWebLlmModel } from '../src/webllm.ts';

const demo = fileURLToPath(new URL('../demo/', import.meta.url));
const report = (msg: string) => console.error(`[llm-browser browser test] ${msg}`);

describe.skipIf(!process.env.LIVE)('live: in-browser LLM demo in headless Chromium', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    const { createServer } = await import('vite');
    const port = 20000 + Math.floor(Math.random() * 10000);
    server = await createServer({ configFile: `${demo}vite.config.mjs`, server: { port, strictPort: true, host: '127.0.0.1' } });
    await server.listen();
    base = `http://127.0.0.1:${port}/`;
    browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function open(): Promise<{ page: Page; support: BrowserAiSupport }> {
    const page = await browser.newPage();
    await page.goto(base);
    await page.waitForFunction(() => document.getElementById('support')?.dataset.state === 'done');
    const support = JSON.parse((await page.getAttribute('#support', 'data-result')) ?? '{}') as BrowserAiSupport;
    return { page, support };
  }

  async function ask(page: Page, rung: string, timeout: number, model?: string) {
    await page.selectOption('#rung', rung);
    if (model) await page.fill('#model', model);
    await page.click('#run');
    await page.waitForFunction(() => ['done', 'error'].includes(document.getElementById('status')?.dataset.state ?? ''), null, {
      timeout,
    });
    return {
      status: (await page.textContent('#status')) ?? '',
      answer: (await page.textContent('#answer')) ?? '',
      result: JSON.parse((await page.getAttribute('#status', 'data-result')) ?? 'null') as {
        deltas: number;
        text: string;
      } | null,
    };
  }

  it('detects WebGPU and the Prompt API', async () => {
    const { page, support } = await open();
    const ua = await page.evaluate(() => navigator.userAgent);
    report(`${ua.match(/HeadlessChrome\/[\d.]+/)?.[0] ?? ua}: ${JSON.stringify(support)}`);
    expect(typeof support.webgpu).toBe('boolean');
    expect(support.webllm).toBe(support.webgpu);
    expect(['available', 'downloadable', 'unavailable']).toContain(support.chromePromptApi);
    await page.close();
  });

  it('runs the Prompt API rung where availability() reports it', async () => {
    const { page, support } = await open();
    if (support.chromePromptApi === 'unavailable') {
      report('Prompt API unavailable here; rung not run');
      await page.close();
      return;
    }
    const out = await ask(page, 'chrome-ai', 280_000);
    if (/no on-device model/.test(out.status)) {
      // Chromium ships the API without Gemini Nano and echoes prompts; the rung must refuse instead of answering.
      report(`Prompt API present without a model (Chromium echo); rung refused as designed: ${out.status}`);
      expect(out.answer).toBe('');
    } else {
      report(`Prompt API answered: ${out.status}`);
      expect(out.status).not.toMatch(/^Error/);
      expect(out.answer.trim().length).toBeGreaterThan(0);
    }
    await page.close();
  }, 300_000);

  it('streams an answer from the smallest WebLLM model where WebGPU exists', async () => {
    const { page, support } = await open();
    if (!support.webgpu) {
      report('no WebGPU adapter; WebLLM not run');
      await page.close();
      return;
    }
    const out = await ask(page, 'webllm', 840_000, smallestWebLlmModel(support.shaderF16));
    report(`WebLLM: ${out.status} answer=${JSON.stringify(out.answer.slice(0, 200))}`);
    expect(out.status).not.toMatch(/^Error/);
    expect(out.answer.trim().length).toBeGreaterThan(0);
    expect(out.result?.deltas ?? 0).toBeGreaterThan(1);
    expect(out.result?.text).toBe(out.answer);
    await page.close();
  }, 900_000);
});
