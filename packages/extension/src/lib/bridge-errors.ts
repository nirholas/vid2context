/**
 * Map any failure to one of the bridge's error codes, with a hint written for
 * someone in a browser (the YouTube provider's own hints talk about server
 * settings such as YOUTUBE_COOKIE, which do not apply here).
 */
import type { ErrorCode } from '@vid2context/core';
import type { BridgeError, BridgeErrorCode } from './bridge-protocol.ts';

export const BRIDGE_HINTS: Record<BridgeErrorCode, string> = {
  'bad-request': 'Send an 11 character YouTube video id and, optionally, a BCP 47 language code.',
  'not-found': 'Check the video link. The video may have been removed, or it is private.',
  unavailable: 'Open the video on YouTube to check that it plays for you, then try again.',
  'no-captions':
    'This video has no captions YouTube can share. Transcribe the audio in vid2context instead, or paste a transcript.',
  blocked:
    'YouTube is refusing caption requests from your network right now. Wait a few minutes and try again, or paste the transcript from YouTube\'s "Show transcript" panel.',
  timeout:
    'YouTube did not deliver the captions in time. Try again; if YouTube asks you to sign in or accept cookies, do that in a normal tab first.',
};

/** The bridge code for a vid2context error code. */
export function bridgeCode(code: ErrorCode | string | undefined): BridgeErrorCode {
  switch (code) {
    case 'bad-request':
    case 'not-found':
    case 'unavailable':
    case 'blocked':
    case 'timeout':
      return code;
    case 'no-transcript':
    case 'no-captions':
      return 'no-captions';
    case 'auth':
    case 'rate-limited':
      return 'blocked';
    default:
      return 'unavailable';
  }
}

function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

export function bridgeError(code: BridgeErrorCode, message: string, hint: string = BRIDGE_HINTS[code]): BridgeError {
  return { code, message, hint };
}

/** Any thrown value as a bridge error. A timeout or abort without a code counts as `timeout`. */
export function toBridgeError(err: unknown): BridgeError {
  const raw = err as { code?: string; name?: string } | null;
  const code =
    raw && typeof raw === 'object' && typeof raw.code === 'string'
      ? bridgeCode(raw.code)
      : raw?.name === 'TimeoutError' || raw?.name === 'AbortError'
        ? 'timeout'
        : 'unavailable';
  return bridgeError(code, messageOf(err));
}

/**
 * The error to report when both steps failed. The tab's answer usually says
 * more (it saw the page), except when it only ran out of time or failed
 * vaguely after the direct request was refused as blocked: then the block is
 * the real cause.
 */
export function finalError(tab: BridgeError, direct: BridgeError): BridgeError {
  if (direct.code === 'blocked' && (tab.code === 'timeout' || tab.code === 'unavailable')) {
    return bridgeError('blocked', `${direct.message} The YouTube tab did not get the captions either: ${tab.message}`);
  }
  return tab;
}
