/**
 * End-to-end tests against a real local API server and the built app served
 * by `vite preview` (which proxies /api to that server). Ports are random in
 * 20000-29999 and passed to workers through the environment.
 *
 *   npm run e2e -w packages/web             no external network: UI, errors, decode, accessibility
 *   LIVE=1 npm run e2e -w packages/web      also YouTube end to end and an upload through speech-to-text
 *   SCREENSHOTS=1 LIVE=1 npm run e2e -w packages/web -- screenshots   refresh docs/guides/web-app/*.png
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const port = () => String(20000 + Math.floor(Math.random() * 10000));
process.env.V2C_E2E_API_PORT ??= port();
process.env.V2C_E2E_WEB_PORT ??= port();
const api = `http://127.0.0.1:${process.env.V2C_E2E_API_PORT}`;
const web = `http://127.0.0.1:${process.env.V2C_E2E_WEB_PORT}`;
const webDir = fileURLToPath(new URL('..', import.meta.url));
const root = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: web,
    browserName: 'chromium',
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx packages/server/src/node.ts',
      cwd: root,
      env: { PORT: process.env.V2C_E2E_API_PORT, HOST: '127.0.0.1' },
      url: `${api}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `npx vite build && npx vite preview --host 127.0.0.1 --strictPort --port ${process.env.V2C_E2E_WEB_PORT}`,
      cwd: webDir,
      env: { VID2CONTEXT_API_PROXY: api },
      url: `${web}/app/`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
