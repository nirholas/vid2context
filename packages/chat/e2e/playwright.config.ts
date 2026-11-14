/**
 * End-to-end tests against the built app in a real Chromium, gated by LIVE=1
 * because they call real services:
 *
 *   client-only  vite preview with no API behind it, so the app runs the LLM
 *                chain in the browser (keyless OVH and Pollinations)
 *   server       vite preview proxying /api/v1 to a local vid2context server
 *                started here on a random port
 *
 *   npm run build -w packages/chat && LIVE=1 npm run e2e -w packages/chat
 *   SCREENSHOTS=1 also writes the guide's screenshots to docs/guides/chat/.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Pick ports once in the main process; workers inherit them through env.
const pick = (name: string) => {
  process.env[name] ??= String(20000 + Math.floor(Math.random() * 9999));
  return Number(process.env[name]);
};
const clientPort = pick('V2C_E2E_CLIENT_PORT');
const serverModePort = pick('V2C_E2E_SERVER_UI_PORT');
const apiPort = pick('V2C_E2E_API_PORT');

const chatDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  testDir: '.',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: '../.e2e-results',
  use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  projects: [
    { name: 'client-only', testMatch: /client\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${clientPort}` } },
    { name: 'server', testMatch: /server\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${serverModePort}` } },
  ],
  webServer: [
    {
      command: `npx vite preview --port ${clientPort} --strictPort --host 127.0.0.1`,
      cwd: chatDir,
      url: `http://127.0.0.1:${clientPort}/chat/`,
      reuseExistingServer: false,
    },
    {
      command: 'npx tsx packages/server/src/node.ts',
      cwd: repoRoot,
      env: { PORT: String(apiPort) },
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite preview --port ${serverModePort} --strictPort --host 127.0.0.1`,
      cwd: chatDir,
      env: { VID2CONTEXT_API: `http://127.0.0.1:${apiPort}` },
      url: `http://127.0.0.1:${serverModePort}/chat/`,
      reuseExistingServer: false,
    },
  ],
});
