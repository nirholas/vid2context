/** Recent results as React state, reloaded whenever history changes anywhere in the app. */
import { useCallback, useEffect, useState } from 'react';
import { countEntries, HISTORY_EVENT, type HistorySummary, listEntries } from './history.ts';

export interface RecentResults {
  entries: HistorySummary[];
  /** Every saved result, which can be more than `entries`. */
  total: number;
  /** False until the first read finishes (or fails). */
  loaded: boolean;
}

export function useRecentResults(limit = 24): RecentResults {
  const [state, setState] = useState<RecentResults>({ entries: [], total: 0, loaded: false });
  const load = useCallback(async () => {
    try {
      const [entries, total] = await Promise.all([listEntries(limit), countEntries()]);
      setState({ entries, total, loaded: true });
    } catch (err) {
      console.error('[vid2context] history is unavailable', err);
      setState((s) => ({ ...s, loaded: true }));
    }
  }, [limit]);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(HISTORY_EVENT, on);
    return () => window.removeEventListener(HISTORY_EVENT, on);
  }, [load]);
  return state;
}
