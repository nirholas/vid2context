import { defineConfig } from '@playwright/test';
import { findChromium } from './scripts/chromium.mjs';

// Serves the built site (dist/) with `astro preview` on a random high port. The config is
// evaluated again in every worker, so the port chosen first is passed down through the env.
process.env.SITE_E2E_PORT ??= String(20000 + Math.floor(Math.random() * 10000));
const port = Number(process.env.SITE_E2E_PORT);

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { executablePath: findChromium() },
  },
  webServer: {
    command: `node node_modules/astro/bin/astro.mjs preview --ignore-lock --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
