// Astro config for vid2context.com. Static output into site/dist, which the
// root wrangler.jsonc serves as Worker assets next to the HTTP API.
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://vid2context.com',
  output: 'static',
  outDir: './dist',
  // One canonical form per page: /docs/providers/ (the Worker's auto-trailing-slash redirects the other).
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always' },
  integrations: [react()],
  prefetch: false,
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    // Repo files (README, docs, fixtures) are read at build time from outside site/.
    server: { fs: { allow: ['..'] } },
  },
});
