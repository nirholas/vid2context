/**
 * Runs in the page's own JavaScript world on youtube.com (manifest
 * `world: "MAIN"`), because only there are the player object and
 * `ytInitialPlayerResponse` reachable. It answers two questions from the
 * content script over window.postMessage and does nothing else:
 *
 * - `player`: the current player response for a video id.
 * - `pot`: a caption URL the player requested with its proof-of-origin token.
 *   When the player has not requested captions yet, captions are switched on
 *   for a moment (so the player makes that request itself) and then restored.
 */
import { PAGE_CHANNEL, type PageRequest, type PageResponse } from '../lib/messages.ts';

interface PlayerResponseLike {
  videoDetails?: { videoId?: string };
}

interface YouTubePlayer {
  getPlayerResponse?(): PlayerResponseLike | undefined;
  loadModule?(name: string): void;
  unloadModule?(name: string): void;
  getOption?(module: string, key: string): unknown;
  setOption?(module: string, key: string, value: unknown): void;
  isSubtitlesOn?(): boolean;
}

const TOKEN_WAIT_MS = 6000;
const tokenUrls: string[] = [];

// Watch caption requests from the start, so a request the player already made is reused.
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.name.includes('/api/timedtext') || !entry.name.includes('pot=')) continue;
      tokenUrls.push(entry.name);
      if (tokenUrls.length > 20) tokenUrls.shift();
    }
  }).observe({ type: 'resource', buffered: true });
} catch {
  // Resource timing unavailable: the content script falls back to the plain track URL.
}

function player(): YouTubePlayer | null {
  return document.getElementById('movie_player') as YouTubePlayer | null;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerResponse(videoId: string): PlayerResponseLike | null {
  const live = player()?.getPlayerResponse?.();
  if (live?.videoDetails?.videoId === videoId) return plain(live);
  const initial = (window as { ytInitialPlayerResponse?: PlayerResponseLike }).ytInitialPlayerResponse;
  if (initial?.videoDetails?.videoId === videoId) return plain(initial);
  return null;
}

function tokenUrlFor(videoId: string): string | undefined {
  for (let i = tokenUrls.length - 1; i >= 0; i--) {
    const url = tokenUrls[i] as string;
    try {
      if (new URL(url).searchParams.get('v') === videoId) return url;
    } catch {
      // Not a URL; skip it.
    }
  }
  return undefined;
}

async function waitFor<T>(probe: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v !== undefined || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function tokenUrl(videoId: string, languageCode: string): Promise<string | null> {
  const known = tokenUrlFor(videoId);
  if (known) return known;
  const p = player();
  if (!p?.loadModule || !p.setOption) return null;
  const wasOn = p.isSubtitlesOn?.() ?? false;
  let previous: unknown;
  try {
    previous = p.getOption?.('captions', 'track');
  } catch {
    previous = undefined;
  }
  try {
    p.loadModule('captions');
    p.setOption('captions', 'track', { languageCode });
  } catch {
    return null;
  }
  const found = await waitFor(() => tokenUrlFor(videoId), TOKEN_WAIT_MS);
  try {
    if (previous && typeof previous === 'object' && 'languageCode' in previous) p.setOption('captions', 'track', previous);
    else if (!wasOn) {
      p.setOption('captions', 'track', {});
      p.unloadModule?.('captions');
    }
  } catch {
    // Restoring the caption state is best effort; the token is already captured.
  }
  return found ?? null;
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const req = event.data as PageRequest | undefined;
  if (!req || req.channel !== PAGE_CHANNEL || req.dir !== 'req') return;
  const reply = (value: unknown) => {
    const res: PageResponse = { channel: PAGE_CHANNEL, dir: 'res', id: req.id, value };
    window.postMessage(res, location.origin);
  };
  if (req.op === 'player') reply(playerResponse(req.videoId));
  else if (req.op === 'pot') void tokenUrl(req.videoId, req.languageCode).then(reply, () => reply(null));
});
