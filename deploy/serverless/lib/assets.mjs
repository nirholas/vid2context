/**
 * Assemble the static tree every serverless target serves:
 *
 *   /                 the landing site (site/, or its Astro build output)
 *   /llms.txt         the repo's llms.txt and llms-full.txt
 *   /app/             packages/web build (Vite)
 *   /chat/            packages/chat build (Vite)
 *
 * Apps that are missing, have no build script, or fail to build are skipped
 * with a reason (or fail the build with `strict`); nothing is ever stubbed.
 * Used by deploy/serverless/build-assets.mjs (Cloudflare), the Vercel build
 * and the GitHub Pages publisher.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Apps mounted under the site. Order matters only for log output. */
export const APPS = [
  { name: 'web', dir: 'packages/web', mount: 'app' },
  { name: 'chat', dir: 'packages/chat', mount: 'chat' },
];

/** Files in a plain static site/ that are sources, not output. */
const SITE_SOURCE_ENTRIES = new Set([
  'package.json',
  'package-lock.json',
  'node_modules',
  'src',
  'dist',
  'public',
  'tsconfig.json',
  'README.md',
]);

/** Cloudflare Workers static assets reject files above 25 MiB. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/**
 * Vite emits ONNX Runtime's WASM next to the apps that bundle transformers.js, but in
 * the browser transformers.js points ONNX Runtime at cdn.jsdelivr.net unless the app
 * sets TRANSFORMERS_WASM_PATH, so these copies are never fetched. Copies above the
 * Workers limit are removed so the deploy can go ahead; every other oversize file still
 * fails the build. Returns the removed paths, relative to `out`.
 */
export function dropUnfetchedOrtWasm(out, log = () => {}) {
  const dropped = [];
  for (const file of walk(out)) {
    if (!/(^|\/)ort-wasm[^/]*\.wasm$/.test(file) || statSync(file).size <= MAX_ASSET_BYTES) continue;
    rmSync(file);
    dropped.push(relative(out, file));
    log(`[assets] dropped ${relative(out, file)} (over 25 MiB; browsers load ONNX Runtime WASM from the CDN)`);
  }
  return dropped;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isAstroSite(siteDir) {
  const pkgPath = join(siteDir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  const pkg = readJson(pkgPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Boolean(pkg.scripts?.build) && ('astro' in deps || readdirSync(siteDir).some((f) => f.startsWith('astro.config.')));
}

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const tail = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
  return { ok: res.status === 0, tail, error: res.error };
}

/** Join a base path ('/' or '/vid2context/') with a mount ('app') into '/vid2context/app/'. */
export function mountPath(basePath, mount) {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return mount ? `${base}${mount}/` : base;
}

/** Normalize '/x', 'x/', '' into '/x/' (and '' into '/'). */
export function normalizeBasePath(p) {
  const trimmed = (p ?? '/').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/**
 * Rewrite root-absolute href, src and action attributes in an HTML string so
 * the page works under a subpath (GitHub Pages project sites). Protocol-relative
 * URLs (//host) and absolute URLs are left alone.
 */
export function rebaseHtml(html, basePath) {
  if (basePath === '/') return html;
  const prefix = basePath.replace(/\/$/, '');
  return html.replace(/\b(href|src|action)="\/(?!\/)([^"]*)"/g, (_m, attr, rest) => `${attr}="${prefix}/${rest}"`);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function copySite(out, opts, log) {
  const siteDir = opts.siteDir;
  if (!existsSync(siteDir)) throw new Error(`${siteDir} is missing; the landing site is required.`);
  if (isAstroSite(siteDir)) {
    if (opts.buildSite) {
      // site/ is its own npm project (not a workspace): install it on a fresh clone.
      if (!existsSync(join(siteDir, 'node_modules'))) {
        log('[assets] site: installing its dependencies (npm ci in site/)');
        const install = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: siteDir });
        if (!install.ok) throw new Error(`site dependency install failed:\n${install.tail}`);
      }
      log(`[assets] site: building the Astro site${opts.basePath !== '/' ? ` with base ${opts.basePath}` : ''}`);
      const args = ['run', 'build', ...(opts.basePath !== '/' ? ['--', '--base', opts.basePath] : [])];
      const res = run('npm', args, { cwd: siteDir });
      if (!res.ok) throw new Error(`site build failed:\n${res.tail}`);
    }
    const dist = join(siteDir, 'dist');
    if (!existsSync(join(dist, 'index.html'))) {
      throw new Error(
        `site/dist/index.html is missing${opts.buildSite ? ' after the Astro build' : ': build the site first (or drop --no-build)'}.`,
      );
    }
    cpSync(dist, out, { recursive: true });
    // Astro applies the base path itself (--base and import.meta.env.BASE_URL); never rebase its HTML again.
    return { name: 'site', mount: '/', status: opts.buildSite ? 'built' : 'copied', source: 'site/dist', rebase: false };
  }
  for (const entry of readdirSync(siteDir)) {
    if (entry.startsWith('.') || SITE_SOURCE_ENTRIES.has(entry) || entry.startsWith('astro.config.')) continue;
    cpSync(join(siteDir, entry), join(out, entry), { recursive: true });
  }
  return { name: 'site', mount: '/', status: 'copied', source: 'site/', rebase: true };
}

function buildApp(root, out, app, opts, log) {
  const dir = join(root, app.dir);
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath))
    return { name: app.name, mount: `/${app.mount}/`, status: 'skipped', reason: `${app.dir} does not exist` };
  const pkg = readJson(pkgPath);
  if (!pkg.scripts?.build) {
    return { name: app.name, mount: `/${app.mount}/`, status: 'skipped', reason: `${app.dir} has no build script` };
  }
  const dist = join(dir, 'dist');
  if (opts.build) {
    const base = mountPath(opts.basePath, app.mount);
    const env = { ...process.env };
    if (opts.apiBase !== undefined) env.VITE_API_BASE = opts.apiBase;
    if (opts.clientOnly) env.VITE_CLIENT_ONLY = '1';
    log(`[assets] ${app.name}: building ${app.dir} (vite base ${base})`);
    const args = ['run', 'build', '-w', app.dir, '--', '--base', base];
    const res = run('npm', args, { cwd: root, env });
    if (!res.ok) {
      const reason = `build failed: ${res.error?.message ?? res.tail.split('\n').at(-1)}`;
      if (opts.strict) throw new Error(`${app.dir} ${reason}\n${res.tail}`);
      return { name: app.name, mount: `/${app.mount}/`, status: 'skipped', reason, log: res.tail };
    }
  }
  if (!existsSync(join(dist, 'index.html'))) {
    const reason = `${relative(root, dist)}/index.html is missing${opts.build ? ' after the build' : ' (run without --no-build)'}`;
    if (opts.strict) throw new Error(`${app.dir}: ${reason}`);
    return { name: app.name, mount: `/${app.mount}/`, status: 'skipped', reason };
  }
  cpSync(dist, join(out, app.mount), { recursive: true });
  return { name: app.name, mount: `/${app.mount}/`, status: opts.build ? 'built' : 'copied', source: relative(root, dist) };
}

/**
 * Mount paths ('/app/', '/chat/') of the apps that made it into the tree. The
 * Worker serves each app's index.html for unknown paths under its mount (see
 * deploy/serverless/cloudflare/spa-fallback.ts). A `_redirects` rule cannot do
 * this on Workers static assets: redirects apply even when a file matches, so
 * `/app/* /app/index.html 200` would also rewrite the app's own JS and CSS.
 */
export function spaMounts(parts) {
  return parts.filter((p) => p.name !== 'site' && p.status !== 'skipped').map((p) => p.mount);
}

/**
 * Build the asset tree.
 * @param {object} o
 * @param {string} o.root        repo root
 * @param {string} o.out         output directory (emptied first)
 * @param {boolean} [o.build]    run the app builds (default true); false copies existing dist/ output
 * @param {boolean} [o.buildSite] run the Astro site build (default: same as build)
 * @param {string} [o.siteDir]   the landing site directory (default <root>/site)
 * @param {boolean} [o.strict]   fail instead of skipping an app that is present but does not build
 * @param {boolean} [o.clientOnly] build apps with VITE_CLIENT_ONLY=1
 * @param {string} [o.apiBase]   VITE_API_BASE for the apps ('' means pure client-only); omit to keep the apps' default
 * @param {string} [o.basePath]  URL prefix the whole tree is served under (default '/')
 * @param {(msg: string) => void} [o.log]
 */
export function buildAssets(o) {
  const root = resolve(o.root);
  const out = resolve(o.out);
  const log = o.log ?? ((m) => console.error(m));
  const opts = {
    build: o.build ?? true,
    strict: o.strict ?? false,
    clientOnly: o.clientOnly ?? false,
    apiBase: o.apiBase,
    basePath: normalizeBasePath(o.basePath),
    siteDir: resolve(o.siteDir ?? join(root, 'site')),
  };
  opts.buildSite = o.buildSite ?? opts.build;
  if (out === root || !out.startsWith(`${root}/`) || out.startsWith(join(root, 'site'))) {
    throw new Error(`Refusing to write assets to ${out}: use a path inside the repo, outside site/, such as dist/assets.`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const parts = [copySite(out, opts, log)];
  for (const name of ['llms.txt', 'llms-full.txt']) {
    const src = join(root, name);
    if (existsSync(src)) cpSync(src, join(out, name));
    else log(`[assets] ${name} is missing at the repo root; not copied`);
  }
  for (const app of APPS) {
    const part = buildApp(root, out, app, opts, log);
    parts.push(part);
    log(`[assets] ${part.name}: ${part.status}${part.reason ? ` (${part.reason})` : ''}`);
  }

  if (opts.basePath !== '/' && parts[0].rebase) {
    // Apps were built with Vite --base; only a plain static site's HTML needs rebasing.
    const appMounts = parts.filter((p) => p.name !== 'site').map((p) => join(out, p.mount));
    for (const file of walk(out)) {
      if (!file.endsWith('.html') || appMounts.some((m) => file.startsWith(m))) continue;
      writeFileSync(file, rebaseHtml(readFileSync(file, 'utf8'), opts.basePath));
    }
  }

  dropUnfetchedOrtWasm(out, log);
  const tooBig = walk(out).filter((f) => statSync(f).size > MAX_ASSET_BYTES);
  if (tooBig.length > 0) {
    throw new Error(`Assets above 25 MiB cannot be served by Workers: ${tooBig.map((f) => relative(out, f)).join(', ')}`);
  }
  const files = walk(out);
  const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
  return { out, parts, files: files.length, bytes, spaMounts: spaMounts(parts) };
}
