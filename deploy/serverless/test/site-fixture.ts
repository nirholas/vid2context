/**
 * The landing site as a fixed, real fixture: the static `site/index.html` and
 * `site/404.html` from commit 09fe38a (the foundation's landing page), read
 * from git at test time. Tests use it so they do not depend on the state of
 * the Astro site that prompt 36 builds in `site/`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATIC_SITE_COMMIT = '09fe38a';

export function staticSiteFixture(root: string): string {
  const dir = mkdtempSync(join(root, '.vid2context', 'site-fixture-'));
  for (const file of ['index.html', '404.html']) {
    const content = execFileSync('git', ['show', `${STATIC_SITE_COMMIT}:site/${file}`], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}
