/**
 * Whether the connected server offers the media toolkit (captions only,
 * frames, clips, batches), asked once per API base and shared by every panel.
 * Older servers answer 404 for /downloads/toolkit: the toolkit is simply off
 * there, and the download panel shows only video and audio, as before.
 */
import { useEffect, useRef, useState } from 'react';
import type { CallOptions } from '../../lib/api.ts';
import { useOptionalApiStatus } from '../../lib/api-status.tsx';
import { getToolkit, type ToolkitInfo } from '../../lib/downloads.ts';

const cache = new Map<string, Promise<ToolkitInfo>>();

/** Forget cached answers (Settings changed the API base, or tests). */
export function clearToolkitCache(): void {
  cache.clear();
}

/** The toolkit when it is on, undefined while asking or when it is off. */
export function useToolkit(call: CallOptions = {}, enabled = true): ToolkitInfo | undefined {
  const base = useOptionalApiStatus()?.state.base ?? call.base ?? '';
  const [info, setInfo] = useState<ToolkitInfo>();
  const fetchRef = useRef(call.fetch);
  fetchRef.current = call.fetch;

  useEffect(() => {
    if (!enabled) {
      setInfo(undefined);
      return;
    }
    let live = true;
    let p = cache.get(base);
    if (!p) {
      p = getToolkit({ base, ...(fetchRef.current ? { fetch: fetchRef.current } : {}) });
      cache.set(base, p);
      p.catch(() => cache.delete(base));
    }
    p.then(
      (t) => live && setInfo(t.enabled ? t : undefined),
      () => live && setInfo(undefined),
    );
    return () => {
      live = false;
    };
  }, [base, enabled]);

  return info;
}
