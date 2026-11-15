/**
 * Turn yt-dlp's stderr into a Vid2ContextError with a stable code and a hint.
 * yt-dlp prints "ERROR: [extractor] id: message" as its last lines; the
 * patterns below match the messages it really prints (recorded samples live
 * in test/fixtures/stderr-*.txt).
 */
import { Vid2ContextError } from '@vid2context/core';

const COOKIES_HINT =
  'Pass your browser cookies with YTDLP_COOKIES_FROM_BROWSER (for example "firefox") or YTDLP_COOKIES_FILE (a Netscape cookies.txt).';

interface Rule {
  test: RegExp;
  code: Vid2ContextError['code'];
  hint: string;
}

const RULES: Rule[] = [
  {
    test: /sign in to confirm you.?re not a bot/i,
    code: 'blocked',
    hint: `The site is blocking this IP address (common for datacenter IPs). Run vid2context on a home connection or behind a Cloudflare Tunnel to one. ${COOKIES_HINT}`,
  },
  {
    test: /\bDRM\b/,
    code: 'unavailable',
    hint: 'This video is DRM protected. vid2context does not support DRM services (Netflix, Spotify, Disney+ and similar).',
  },
  {
    test: /private video/i,
    code: 'unavailable',
    hint: `The video is private. If your account can see it, ${COOKIES_HINT.charAt(0).toLowerCase()}${COOKIES_HINT.slice(1)}`,
  },
  {
    test: /video unavailable|this video is unavailable|this video has been removed|has been terminated|HTTP Error 404|HTTP Error 410/i,
    code: 'not-found',
    hint: 'Check the URL; the video may have been removed or never existed.',
  },
  {
    test: /unsupported url/i,
    code: 'unsupported-input',
    hint: 'yt-dlp has no extractor for this site. Pass a direct media URL or a page from a supported site (yt-dlp --list-extractors).',
  },
  {
    test: /HTTP Error 429|too many requests/i,
    code: 'rate-limited',
    hint: `The site is rate limiting this IP. Wait a few minutes and retry. ${COOKIES_HINT}`,
  },
  {
    test: /requested format is not available/i,
    code: 'unavailable',
    hint: 'No downloadable audio or video format was offered for this URL. Update yt-dlp (it updates weekly by itself) or retry later.',
  },
  {
    test: /ffmpeg not found|ffprobe and ffmpeg not found|ffmpeg is not installed|ffprobe\/avprobe and ffmpeg\/avconv not found/i,
    code: 'no-provider',
    hint: 'Audio extraction needs ffmpeg. Install it (apt install ffmpeg, brew install ffmpeg) or set FFMPEG_PATH to the binary.',
  },
  {
    test: /only works when logged-in|login required|requires authentication|account credentials|this content isn.t available to everyone|age.restricted|confirm your age/i,
    code: 'auth',
    hint: `The site wants a signed-in account for this video. ${COOKIES_HINT}`,
  },
  {
    test: /geo.?restrict|not available in your country|not made this video available in your country/i,
    code: 'unavailable',
    hint: 'The video is not available from this country. Run vid2context from a location where it plays.',
  },
];

/**
 * Messages yt-dlp prints when an extractor broke, usually because the site
 * changed: it asks for a bug report and to "Confirm you are on the latest
 * version using yt-dlp -U" (recorded in test/fixtures/stderr-outdated-*.txt).
 */
const OUTDATED =
  /confirm you are on the latest version|yt-dlp -U\b|please report this issue|nsig extraction failed|signature extraction failed|unable to extract|no video formats found/i;

/** True when the failure is one a newer yt-dlp release may fix (and no more specific rule explains it). */
export function suggestsUpdate(stderr: string, err?: Vid2ContextError): boolean {
  if (err && err.code !== 'upstream' && err.code !== 'unavailable') return false;
  return OUTDATED.test(lastError(stderr)) || OUTDATED.test(stderr.slice(-4000));
}

/** The last "ERROR:" line, else the last non-empty line, trimmed and bounded. */
export function lastError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith('ERROR:'));
  return (err ?? lines.at(-1) ?? '').replace(/^ERROR:\s*/, '').slice(0, 500);
}

/** Map a failed yt-dlp run to an error. `label` names the step for the message. */
export function errorFromStderr(stderr: string, label: string, exitCode: number | null = null): Vid2ContextError {
  const line = lastError(stderr);
  const message = `${label}: ${line || `yt-dlp exited with code ${exitCode ?? 'unknown'}`}`;
  for (const rule of RULES) {
    if (rule.test.test(line) || (!line && rule.test.test(stderr))) {
      return new Vid2ContextError(rule.code, message, { hint: rule.hint });
    }
  }
  return new Vid2ContextError('upstream', message, {
    hint: 'yt-dlp failed. Updating it often helps (delete .vid2context/bin/yt-dlp.json to force an update check), or retry later.',
  });
}
