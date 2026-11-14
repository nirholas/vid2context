/**
 * Build the extension for Chrome/Edge and Firefox.
 *
 * 1. Popup and options pages: one Vite build (React, Tailwind) with two HTML entries.
 * 2. Background, content script and main-world page script: one self-contained
 *    IIFE each (content scripts cannot be ES modules, and one format for the
 *    background keeps Chrome's service worker and Firefox's event page alike).
 * 3. Icons rasterized from the project logo.
 * 4. The shared output is copied to dist/chrome and dist/firefox, each with
 *    its own manifest from src/manifest.ts.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build, type InlineConfig } from 'vite';
import { manifestFor, type TargetBrowser } from '../src/manifest.ts';
import { ICON_SIZES, iconPng } from './icons.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(pkgDir, 'src');
const dist = join(pkgDir, 'dist');
const stage = join(dist, '.stage');
const version = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;

const shared: InlineConfig = {
  configFile: false,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
};

async function buildPages(): Promise<void> {
  await build({
    ...shared,
    root: src,
    base: './',
    plugins: [react(), tailwindcss()],
    build: {
      outDir: stage,
      emptyOutDir: false,
      modulePreload: { polyfill: false },
      target: ['chrome111', 'firefox140'],
      rollupOptions: {
        input: { popup: join(src, 'popup/index.html'), options: join(src, 'options/index.html') },
      },
    },
  });
}

async function buildScript(name: string, entry: string): Promise<void> {
  await build({
    ...shared,
    root: pkgDir,
    build: {
      outDir: stage,
      emptyOutDir: false,
      target: ['chrome111', 'firefox140'],
      lib: { entry: join(src, entry), formats: ['iife'], name: `vid2context_${name}`, fileName: () => `${name}.js` },
    },
  });
}

function writeIcons(): void {
  mkdirSync(join(stage, 'icons'), { recursive: true });
  for (const size of ICON_SIZES) writeFileSync(join(stage, 'icons', `${size}.png`), iconPng(size));
}

function emit(browser: TargetBrowser): void {
  const out = join(dist, browser);
  cpSync(stage, out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifestFor({ browser, version }), null, 2)}\n`);
  console.error(`built ${out}`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
await buildPages();
await buildScript('background', 'background/index.ts');
await buildScript('content', 'content/index.ts');
await buildScript('page', 'page/index.ts');
writeIcons();
emit('chrome');
emit('firefox');
rmSync(stage, { recursive: true, force: true });
