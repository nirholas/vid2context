/**
 * Whether an API server is reachable. Checked once at startup with
 * GET /health (and again from Settings). When it is not, or when the app was
 * built with VITE_CLIENT_ONLY=1, the app runs in client-only mode.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { apiBase, CLIENT_ONLY_BUILD, getHealth, type Health, hasApiOverride } from './api.ts';
import type { AppError } from './errors.ts';

export type ApiState =
  | { status: 'checking'; base: string }
  | { status: 'online'; base: string; health: Health }
  | { status: 'offline'; base: string; error: AppError }
  | { status: 'client-only-build'; base: string };

export interface ApiStatus {
  state: ApiState;
  recheck: () => Promise<void>;
}

/** True when links cannot be fetched and uploads are transcribed in the browser. */
export function isClientOnly(state: ApiState): boolean {
  return state.status === 'offline' || state.status === 'client-only-build';
}

const Ctx = createContext<ApiStatus | null>(null);

const PROBE_TIMEOUT_MS = 6000;

export function ApiStatusProvider({ children, initial }: { children: ReactNode; initial?: ApiState }) {
  const [state, setState] = useState<ApiState>(
    initial ??
      (CLIENT_ONLY_BUILD && !hasApiOverride()
        ? { status: 'client-only-build', base: apiBase() }
        : { status: 'checking', base: apiBase() }),
  );
  const recheck = useCallback(async () => {
    if (CLIENT_ONLY_BUILD && !hasApiOverride()) {
      setState({ status: 'client-only-build', base: apiBase() });
      return;
    }
    const base = apiBase();
    setState({ status: 'checking', base });
    try {
      const health = await getHealth({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), base });
      setState({ status: 'online', base, health });
    } catch (err) {
      setState({ status: 'offline', base, error: err as AppError });
    }
  }, []);
  useEffect(() => {
    if (!initial) void recheck();
  }, [initial, recheck]);
  return <Ctx.Provider value={{ state, recheck }}>{children}</Ctx.Provider>;
}

export function useApiStatus(): ApiStatus {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApiStatus needs an ApiStatusProvider');
  return v;
}

/** The API status, or null outside an ApiStatusProvider (components rendered on their own, as in tests). */
export function useOptionalApiStatus(): ApiStatus | null {
  return useContext(Ctx);
}
