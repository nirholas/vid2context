import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Static app served under /chat/. The API is same-origin at /api/v1 by default;
// in development, VID2CONTEXT_API (for example http://127.0.0.1:8787) is proxied there.
export default defineConfig({
  base: '/chat/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 700,
  },
  server: {
    proxy: process.env.VID2CONTEXT_API ? { '/api/v1': { target: process.env.VID2CONTEXT_API, changeOrigin: true } } : undefined,
  },
});
