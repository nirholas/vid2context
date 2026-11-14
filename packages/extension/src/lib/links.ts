/** URLs the extension hands off to: the web app, the HTTP API and host permission patterns. */

/** `<appBase>/app/?url=<encoded input>`, the web app's start-a-run link. */
export function appLink(appBase: string, input: string): string {
  return `${appBase}/app/?url=${encodeURIComponent(input)}`;
}

/** `GET <apiBase>/transcript?url=&format=&timestamps=`. */
export function apiTranscriptLink(apiBase: string, input: string, format: string, timestamps: boolean): string {
  const qs = new URLSearchParams({ url: input, format });
  if (timestamps) qs.set('timestamps', '1');
  return `${apiBase}/transcript?${qs}`;
}

/** The host permission pattern covering a base URL. Ports are left out: match patterns without one match any port. */
export function originPattern(base: string): string {
  const u = new URL(base);
  return `${u.protocol}//${u.hostname}/*`;
}

/** True for URLs worth sending to vid2context (http and https only; not blob:, data:, chrome:). */
export function isWebUrl(raw: string | undefined): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The video id when the URL is a YouTube watch page (www or m), otherwise null. */
export function youtubeWatchId(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.hostname !== 'www.youtube.com' && u.hostname !== 'm.youtube.com' && u.hostname !== 'youtube.com') return null;
    if (u.pathname !== '/watch') return null;
    const v = u.searchParams.get('v');
    return v && /^[\w-]{11}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
