/**
 * The standalone app: opens the store, detects server or client-only mode,
 * builds the backend and renders the workspace. Reconnecting (new API base
 * or server key) and saving provider keys rebuild the backend in place.
 */
import { useCallback, useEffect, useState } from 'react';
import { toErrorData } from '../lib/api.ts';
import type { Backend } from '../lib/backend.ts';
import { createBackend } from '../lib/bootstrap.ts';
import { getApiBase, setApiBase } from '../lib/settings.ts';
import { type ChatStore, openChatStore, saveProviderKeys, saveServerApiKey } from '../lib/store.ts';
import type { ChatErrorData } from '../lib/types.ts';
import { ChatWorkspace } from './ChatWorkspace.tsx';
import { ErrorCard } from './ErrorCard.tsx';
import { Spinner } from './ui.tsx';

export interface ChatAppProps {
  /** Overrides the API base (default: localStorage v2c.apiBase, then VITE_API_BASE, then /api/v1). */
  apiBase?: string;
  /** Query string to read ?input= and ?collection= from. Default: the page's. */
  search?: string;
}

export function ChatApp(props: ChatAppProps) {
  const [store, setStore] = useState<ChatStore | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [apiBase, setBase] = useState(props.apiBase ?? getApiBase());
  const [error, setError] = useState<ChatErrorData | null>(null);
  const params = new URLSearchParams(props.search ?? (typeof window !== 'undefined' ? window.location.search : ''));
  const initialInput = params.get('input') ?? undefined;
  const initialCollection = params.get('collection') ?? undefined;

  const connect = useCallback(async (s: ChatStore, base: string) => {
    try {
      setError(null);
      setBackend(await createBackend(s, { apiBase: base }));
    } catch (err) {
      setError(toErrorData(err));
    }
  }, []);

  useEffect(() => {
    let live = true;
    openChatStore().then((s) => {
      if (!live) return;
      setStore(s);
      connect(s, apiBase);
    });
    return () => {
      live = false;
    };
    // Start once; reconnects go through onReconnect.
    // biome-ignore lint/correctness/useExhaustiveDependencies: start-up only.
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorCard error={error} onRetry={() => store && connect(store, apiBase)} />
      </div>
    );
  }
  if (!store || !backend) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Connecting" />
      </div>
    );
  }
  return (
    <ChatWorkspace
      backend={backend}
      store={store}
      apiBase={apiBase}
      {...(initialInput ? { initialInput } : {})}
      {...(initialCollection ? { initialCollection } : {})}
      onReconnect={async (base, serverKey) => {
        setApiBase(base);
        await saveServerApiKey(serverKey);
        const next = base.trim() || getApiBase();
        setBase(next);
        setBackend(await createBackend(store, { apiBase: next }));
      }}
      onKeysSaved={async (keys) => {
        await saveProviderKeys(keys);
        if (backend.mode === 'client') setBackend(await createBackend(store, { apiBase }));
      }}
    />
  );
}
