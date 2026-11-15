/**
 * Whether the connected server offers downloads. Asked once per API base and
 * shared by every panel; client-only and offline modes never ask.
 */
import { useEffect, useRef, useState } from 'react';
import type { CallOptions } from '../../lib/api.ts';
import { type ApiState, isClientOnly, useOptionalApiStatus } from '../../lib/api-status.tsx';
import { type DownloadStatus, getDownloadStatus } from '../../lib/downloads.ts';

export type DownloadAvailability =
  | { state: 'checking' }
  | { state: 'on'; status: DownloadStatus }
  | { state: 'off'; reason: string; status?: DownloadStatus };

const cache = new Map<string, Promise<DownloadStatus>>();

/** Forget cached answers (Settings changed the API base, or tests). */
export function clearDownloadStatusCache(): void {
  cache.clear();
}

/** `call` lets tests pass a fetch that replays recorded responses. */
export function useDownloadStatus(call: CallOptions = {}): DownloadAvailability {
  // Outside the app shell there is no API status: treat it like client-only, so nothing is fetched.
  const state: ApiState | undefined = useOptionalApiStatus()?.state;
  const [result, setResult] = useState<DownloadAvailability>({ state: 'checking' });
  const base = state?.base ?? '';
  const online = state?.status === 'online';
  const clientOnly = !state || isClientOnly(state);
  const fetchRef = useRef(call.fetch);
  fetchRef.current = call.fetch;

  useEffect(() => {
    if (clientOnly) {
      setResult({ state: 'off', reason: 'Downloads need a vid2context server: yt-dlp and ffmpeg cannot run in the browser.' });
      return;
    }
    if (!online) {
      setResult({ state: 'checking' });
      return;
    }
    let live = true;
    let p = cache.get(base);
    if (!p) {
      p = getDownloadStatus({ base, ...(fetchRef.current ? { fetch: fetchRef.current } : {}) });
      cache.set(base, p);
      p.catch(() => cache.delete(base));
    }
    p.then(
      (status) => {
        if (!live) return;
        setResult(
          status.enabled
            ? { state: 'on', status }
            : { state: 'off', status, reason: status.reason ?? 'Downloads are off on this server.' },
        );
      },
      (err) => {
        if (!live) return;
        // An older server without the route answers 404: downloads are simply not there.
        const message = err instanceof Error ? err.message : String(err);
        setResult({ state: 'off', reason: `This server does not offer downloads (${message}).` });
      },
    );
    return () => {
      live = false;
    };
  }, [base, online, clientOnly]);

  return result;
}
