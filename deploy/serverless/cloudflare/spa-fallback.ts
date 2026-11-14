/**
 * SPA fallback for the Cloudflare Worker's static assets.
 *
 * The web app (/app/) and the chat app (/chat/) are single-page apps: a deep
 * link such as /app/runs/42 has no file behind it and must serve
 * /app/index.html, while unknown paths elsewhere keep the site's 404 page.
 * Workers static assets only offer a global `single-page-application` mode,
 * and `_redirects` rewrites apply even when a file exists (they would turn the
 * app's own /app/assets/*.js requests into index.html), so the Worker does
 * this itself: ask ASSETS first, and only on a 404 for a GET or HEAD under an
 * app mount, serve that app's index.html.
 *
 * Wiring (packages/server/src/workers.ts, owned by prompt 46): replace
 *   return env.ASSETS.fetch(req);
 * with
 *   return fetchAssetWithSpaFallback(req, env.ASSETS);
 */

export interface AssetsBinding {
  fetch(req: Request): Promise<Response>;
}

/** App mounts served by the Worker, matching deploy/serverless/lib/assets.mjs APPS. */
export const SPA_MOUNTS = ['/app/', '/chat/'] as const;

/** The mount a path belongs to, or undefined. '/app' (no trailing slash) counts as '/app/'. */
export function spaMountFor(pathname: string, mounts: readonly string[] = SPA_MOUNTS): string | undefined {
  return mounts.find((m) => pathname === m.slice(0, -1) || pathname.startsWith(m));
}

/** Paths that look like files (have an extension in the last segment) never fall back: a missing JS file stays a 404. */
function looksLikeFile(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /\.[a-z0-9]{1,8}$/i.test(last);
}

export async function fetchAssetWithSpaFallback(
  req: Request,
  assets: AssetsBinding,
  mounts: readonly string[] = SPA_MOUNTS,
): Promise<Response> {
  const res = await assets.fetch(req);
  if (res.status !== 404 || (req.method !== 'GET' && req.method !== 'HEAD')) return res;
  const url = new URL(req.url);
  const mount = spaMountFor(url.pathname, mounts);
  if (!mount || looksLikeFile(url.pathname)) return res;
  // Ask for the mount directory itself: with html_handling "auto-trailing-slash",
  // /app/index.html answers with a redirect to /app/, which serves the index.
  const index = await assets.fetch(new Request(new URL(mount, url), { method: req.method, headers: req.headers }));
  // The app is not deployed (skipped at build time): keep the original 404 page.
  if (!index.ok) return res;
  return new Response(index.body, { status: 200, headers: index.headers });
}
