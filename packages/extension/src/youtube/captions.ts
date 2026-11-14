/**
 * Download a caption track from youtube.com and parse it with the YouTube
 * provider's parsers.
 *
 * Watch-page track URLs carry `exp=xpe`: YouTube answers them with an empty
 * body unless the request also carries the proof-of-origin token (`pot`) the
 * web player attaches to its own caption requests. So the fetch first tries
 * the plain URL, and when that comes back empty it borrows the player's token
 * (see `PoToken`) and tries again.
 */
import { errorFromResponse, type Segment, Vid2ContextError } from '@vid2context/core';
import { parseTimedText } from '@vid2context/provider-youtube';
import type { CaptionTrack } from './player.ts';

/** The token and client the web player sends with its own caption requests. */
export interface PoToken {
  pot: string;
  /** Client name, `WEB` on desktop. */
  c?: string;
  /** Client version. */
  cver?: string;
}

/** The token from a timedtext URL the player requested for `videoId`, or null when it has none. */
export function poTokenFromUrl(raw: string, videoId: string): PoToken | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!u.pathname.endsWith('/api/timedtext') || u.searchParams.get('v') !== videoId) return null;
  const pot = u.searchParams.get('pot');
  if (!pot) return null;
  const c = u.searchParams.get('c') ?? undefined;
  const cver = u.searchParams.get('cver') ?? undefined;
  return { pot, ...(c ? { c } : {}), ...(cver ? { cver } : {}) };
}

/** The track URL with a format and, when given, the player's token and a machine translation target (`tlang`). */
export function trackUrl(baseUrl: string, opts: { fmt?: 'srv3'; po?: PoToken | null; tlang?: string }): string {
  const u = new URL(baseUrl, 'https://www.youtube.com');
  if (opts.fmt) u.searchParams.set('fmt', opts.fmt);
  else u.searchParams.delete('fmt');
  if (opts.tlang) u.searchParams.set('tlang', opts.tlang);
  if (opts.po) {
    u.searchParams.set('pot', opts.po.pot);
    u.searchParams.set('potc', '1');
    if (opts.po.c) u.searchParams.set('c', opts.po.c);
    if (opts.po.cver) u.searchParams.set('cver', opts.po.cver);
  }
  return u.href;
}

export interface CaptionDeps {
  fetch: typeof fetch;
  /** Ask the page for the player's token. Called only when the plain URL comes back empty. */
  getPoToken: () => Promise<PoToken | null>;
  signal?: AbortSignal;
  /** YouTube's machine translation target, from the track choice's `translateTo`. */
  translateTo?: string;
}

export interface CaptionResult {
  segments: Segment[];
  /** True when the player's proof-of-origin token was needed. */
  usedPoToken: boolean;
}

const BLOCKED_HINT =
  'YouTube is refusing caption requests from this network for now. Wait a few minutes and try again, or use "Open in vid2context", which can transcribe the audio instead.';

async function download(url: string, label: string, deps: CaptionDeps): Promise<Segment[]> {
  const res = await deps.fetch(url, { credentials: 'include', signal: deps.signal });
  if (res.status === 429) {
    throw new Vid2ContextError('blocked', `${label}: YouTube answered HTTP 429 (automated queries).`, {
      status: 429,
      hint: BLOCKED_HINT,
    });
  }
  if (!res.ok) throw await errorFromResponse(res, label);
  return parseTimedText(await res.text());
}

export async function fetchCaptionSegments(track: CaptionTrack, deps: CaptionDeps): Promise<CaptionResult> {
  const tlang = deps.translateTo;
  const label = `YouTube captions (${track.languageCode}${tlang ? ` to ${tlang}` : ''})`;
  const plain = await download(trackUrl(track.baseUrl, { fmt: 'srv3', tlang }), label, deps);
  if (plain.length) return { segments: plain, usedPoToken: false };

  const po = await deps.getPoToken();
  if (po) {
    const srv3 = await download(trackUrl(track.baseUrl, { fmt: 'srv3', po, tlang }), label, deps);
    if (srv3.length) return { segments: srv3, usedPoToken: true };
  }
  const srv1 = await download(trackUrl(track.baseUrl, { po, tlang }), label, deps);
  if (srv1.length) return { segments: srv1, usedPoToken: !!po };

  throw new Vid2ContextError('no-transcript', `${label}: YouTube returned an empty caption track.`, {
    hint: 'Turn captions on in the player for a moment and try again, or use "Open in vid2context" to transcribe the audio.',
  });
}
