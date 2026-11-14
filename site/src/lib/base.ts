/**
 * Prefix a root-absolute path with Astro's base, so a build with
 * `--base /vid2context/` (GitHub Pages project site) keeps working links.
 * Canonical and Open Graph URLs always use https://vid2context.com instead.
 */
const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

export function withBase(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  return `${BASE}${path}`;
}
