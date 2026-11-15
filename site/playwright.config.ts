import { defineConfig } from '@playwright/test';
import { findChromium } from './scripts/chromium.mjs';

// Serves the built site (dist/) with `astro preview` on a random high port. The config is
// evaluated again in every worker, so the port chosen first is passed down through the env.
process.env.SITE_E2E_PORT ??= String(20000 + Math.floor(Math.random() * 10000));
const port = Number(process.env.SITE_E2E_PORT);
// A real HTTP API next to it for the runnable examples: memory storage (nothing persists), and CORS
// open to the preview origin only, exactly as the docs tell readers to start their own server.
process.env.SITE_E2E_API_PORT ??= String(port + 1);
const apiPort = Number(process.env.SITE_E2E_API_PORT);

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { executablePath: findChromium() },
  },
  webServer: [
    {
      command: `node node_modules/astro/bin/astro.mjs preview --ignore-lock --host 127.0.0.1 --port ${port}`,
      url: `http://127.0.0.1:${port}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx tsx packages/server/src/node.ts',
      cwd: '..',
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      env: {
        PORT: String(apiPort),
        HOST: '127.0.0.1',
        VID2CONTEXT_STORAGE: 'memory',
        VID2CONTEXT_CORS_ORIGINS: `http://127.0.0.1:${port}`,
        VID2CONTEXT_ACCESS_LOG: '0',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
