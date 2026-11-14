/**
 * The app's state lives in the query string, so every view has a link and
 * one index.html serves all of them on any static host:
 *   /app/                                   home
 *   /app/?url=<input>&mode=&lang=&comments=1&timestamps=1   run and show the result
 *   /app/?view=settings                     settings
 */

import type { TranscriptMode } from '@vid2context/core';
import { useEffect, useState } from 'react';

export const MODES: { id: TranscriptMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Captions when they exist, otherwise speech-to-text.' },
  { id: 'captions', label: 'Captions only', hint: 'Never download or transcribe audio.' },
  { id: 'stt', label: 'Speech-to-text', hint: 'Always transcribe the audio, even when captions exist.' },
  { id: 'video', label: 'Video model', hint: 'A multimodal model watches the video: transcript plus on-screen notes.' },
];

export interface RunParams {
  url: string;
  mode: TranscriptMode;
  lang: string;
  comments: boolean;
  timestamps: boolean;
}

export type Route = { view: 'home' } | { view: 'settings' } | ({ view: 'run' } & RunParams);

const ON = ['1', 'true', 'yes'];

export function readMode(v: string | null): TranscriptMode {
  return MODES.some((m) => m.id === v) ? (v as TranscriptMode) : 'auto';
}

export function parseRoute(search: string): Route {
  const q = new URLSearchParams(search);
  if (q.get('view') === 'settings') return { view: 'settings' };
  const url = q.get('url')?.trim();
  if (url) {
    return {
      view: 'run',
      url,
      mode: readMode(q.get('mode')),
      lang: q.get('lang')?.trim() ?? '',
      comments: ON.includes(q.get('comments') ?? ''),
      timestamps: ON.includes(q.get('timestamps') ?? ''),
    };
  }
  return { view: 'home' };
}

export function runSearch(p: Partial<RunParams> & { url: string }): string {
  const q = new URLSearchParams({ url: p.url });
  if (p.mode && p.mode !== 'auto') q.set('mode', p.mode);
  if (p.lang) q.set('lang', p.lang);
  if (p.comments) q.set('comments', '1');
  if (p.timestamps) q.set('timestamps', '1');
  return `?${q.toString()}`;
}

/** The app's own path, from Vite's base ("/app/"). */
export const BASE: string = import.meta.env.BASE_URL ?? '/app/';

export function appHref(search = ''): string {
  return `${BASE}${search}`;
}

const listeners = new Set<() => void>();

export function navigate(search: string, opts: { replace?: boolean } = {}): void {
  const href = appHref(search);
  if (opts.replace) history.replaceState(null, '', href);
  else history.pushState(null, '', href);
  for (const l of listeners) l();
  window.scrollTo({ top: 0 });
}

export function useRoute(): Route {
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return parseRoute(search);
}

/** Links that navigate inside the app without a reload, but still work as plain links. */
export function onAppLinkClick(e: React.MouseEvent<HTMLAnchorElement>, search: string): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(search);
}
