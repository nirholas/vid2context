/** Loaders and replay routes for the recorded SponsorBlock responses in ./fixtures (see its README). */
import { readFileSync } from 'node:fs';
import type { VideoContext, VideoRef } from '@vid2context/core';
import type { Route } from '@vid2context/core/testing';

export const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Real VideoContext for "I Let My Staff Upgrade the Office" (Linus Tech Tips), recorded through the CLI. */
export const officeContext = (): VideoContext => JSON.parse(fixture('context-youtube-CrO0Timw2z4.json')) as VideoContext;

/** A YouTube video ref in the shape the YouTube source resolves to. */
export function youtubeRef(id: string): VideoRef {
  const url = `https://www.youtube.com/watch?v=${id}`;
  return { input: url, platform: 'youtube', kind: 'video', id: `youtube:${id}`, nativeId: id, url };
}

/** Category list a request asked for. */
export function requestedCategories(url: string): string[] {
  return JSON.parse(new URL(url).searchParams.get('categories') ?? '[]') as string[];
}

/**
 * The recorded responses. Each prefix file was recorded with every category
 * and action type, so the client-side category filter is exercised too. The
 * 404 was recorded for prefix 9007 asking only for exclusive_access.
 */
export const routes: Route[] = [
  {
    url: (u) => u.pathname === '/api/skipSegments/9007' && requestedCategories(u.href).join() === 'exclusive_access',
    response: {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: fixture('skipSegments-9007-exclusive_access-404.json'),
    },
  },
  {
    url: (u) => u.pathname === '/api/skipSegments/9007',
    response: { headers: { 'content-type': 'application/json; charset=utf-8' }, body: fixture('skipSegments-9007.json') },
  },
  {
    url: (u) => u.pathname === '/api/skipSegments/2d69',
    response: { headers: { 'content-type': 'application/json; charset=utf-8' }, body: fixture('skipSegments-2d69.json') },
  },
];
