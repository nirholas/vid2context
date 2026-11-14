import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

/** Serves the demo in dev only; the demo is not part of the published package. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { fs: { allow: [repo] } },
  optimizeDeps: { exclude: ['@mlc-ai/web-llm'] },
  logLevel: 'warn',
});
