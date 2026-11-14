/**
 * Builds the web app to static files under base /app/. Every host that can
 * serve a folder (Cloudflare, Vercel, GitHub Pages) can serve dist/.
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.VID2CONTEXT_API_PROXY ?? 'http://127.0.0.1:8787';

export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': { target: api, changeOrigin: true } } },
  preview: { proxy: { '/api': { target: api, changeOrigin: true } } },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
});
