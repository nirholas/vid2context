/** Shared test helpers: the real fixtures, and recorded API responses served through replayFetch. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { VideoContext } from '@vid2context/core';
import { type Route, replayFetch } from '@vid2context/core/testing';

export const BASE = 'http://127.0.0.1:8787/api/v1';

/**
 * The repo root, found by walking up from the working directory. Under jsdom
 * import.meta.url is not a file: URL, so paths are resolved from here instead.
 */
function repoRoot(): string {
  let dir = resolve(process.cwd());
  while (!existsSync(join(dir, 'tests', 'fixtures', 'contexts'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('Run the tests from inside the vid2context repo.');
    dir = up;
  }
  return dir;
}

export const ROOT = repoRoot();

/** Real VideoContext output from tests/fixtures/contexts. */
export function sharedContext(name: 'youtube-jNQXAC9IVRw' | 'youtube-cCPsdFdlshc'): VideoContext {
  return JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'contexts', `${name}.json`), 'utf8')) as VideoContext;
}

export interface Recorded {
  request: { method: string; path: string };
  status: number;
  contentType: string;
  body: unknown;
}

/** A response recorded by scripts/record-fixtures.ts. */
export function recorded(name: string): Recorded {
  return JSON.parse(readFileSync(join(ROOT, 'packages', 'web', 'test', 'fixtures', name), 'utf8')) as Recorded;
}

/** Serve recorded responses at the paths they were recorded from, under BASE. */
export function replay(...names: string[]) {
  const routes: Route[] = names.map((name) => {
    const r = recorded(name);
    const path = r.request.path;
    return {
      method: r.request.method,
      url: (u: URL) => u.href === `${BASE}${path}` || (u.pathname === new URL(`${BASE}${path}`).pathname && !path.includes('?')),
      response: {
        status: r.status,
        headers: { 'content-type': r.contentType },
        body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      },
    };
  });
  return replayFetch(routes);
}
