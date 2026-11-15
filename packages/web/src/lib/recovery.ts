/**
 * Recoveries in the web app: the same ranked suggestions as every other
 * surface (core recovery.ts), worded for the browser and limited to what
 * this app and the connected server can actually do.
 */
import { type Attempt, type Recovery, type RecoveryContext, suggestRecoveries, type TranscriptMode } from '@vid2context/core';
import type { ApiState } from './api-status.tsx';
import { attemptsOfError } from './errors.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Provider key names the connected server accepts per request; empty when it does not. */
export function acceptedKeyNames(api: ApiState): string[] {
  if (api.status !== 'online') return [];
  const rk = api.health.requestKeys;
  return rk?.accepted ? rk.names : [];
}

/** True when the API runs on another machine (running vid2context locally is then a real alternative). */
export function isRemoteApi(base: string, here: string = globalThis.location?.href ?? 'http://localhost/'): boolean {
  try {
    return !LOOPBACK.has(new URL(base, here).hostname);
  } catch {
    return true;
  }
}

export function webRecoveryContext(
  api: ApiState,
  input: string,
  opts: { mode?: TranscriptMode; downloads: boolean },
): RecoveryContext {
  const names = acceptedKeyNames(api);
  return {
    surface: 'web',
    input,
    ...(opts.mode ? { mode: opts.mode } : {}),
    downloads: opts.downloads,
    keys: names.length > 0 ? 'request' : 'none',
    keyNames: names,
    imports: true,
    remote: isRemoteApi(api.base),
  };
}

export function webRecoveries(err: unknown, rc: RecoveryContext): Recovery[] {
  const attempts: Attempt[] = attemptsOfError(err);
  return suggestRecoveries(err, rc, attempts);
}

/** Actions the import panel (extension, media file, server download, paste, subtitle file) already carries out. */
export const IMPORT_ACTIONS: ReadonlySet<Recovery['action']> = new Set([
  'download-media',
  'from-browser',
  'import-transcript',
  'local-file',
]);

/** One plain sentence on what went wrong, for the panel's heading area. Technical detail stays in the collapsed section. */
export function plainReason(code: string, input: string): string {
  const yt = /youtu\.?be/i.test(input);
  switch (code) {
    case 'blocked':
      return yt
        ? 'YouTube is refusing requests from this server right now, so it could not read the video directly.'
        : 'The site is refusing requests from this server right now, so it could not read the video directly.';
    case 'no-transcript':
      return 'This video has no captions the server could read, and transcribing its audio did not work here.';
    case 'no-provider':
    case 'all-rungs-failed':
      return 'The service this step needs is not set up on this server, or its free limits ran out.';
    case 'auth':
      return 'A provider rejected the key it was given.';
    case 'rate-limited':
      return 'Too many requests went out in a short time.';
    case 'too-large':
      return 'The file is larger than the services here accept.';
    case 'timeout':
      return 'This took longer than the server allows for one request.';
    case 'unavailable':
      return 'The video is private, members-only, age-restricted or blocked in this region.';
    case 'not-found':
      return 'Nothing was found at this link.';
    case 'unsupported-input':
      return 'This link is not one vid2context can read as a single video.';
    default:
      return 'Something between this server and the video service failed.';
  }
}
