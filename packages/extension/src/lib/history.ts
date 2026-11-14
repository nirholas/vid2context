/** The last few things the user sent through the extension, kept in `storage.local`. */
export type HistoryAction = 'copy' | 'zip' | 'open' | 'api-copy';

export interface HistoryItem {
  url: string;
  title: string;
  action: HistoryAction;
  /** ISO 8601. */
  at: string;
}

export const HISTORY_LIMIT = 5;
const HISTORY_KEY = 'history';

type LocalArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

function valid(x: unknown): x is HistoryItem {
  const i = x as HistoryItem;
  return (
    !!i && typeof i.url === 'string' && typeof i.title === 'string' && typeof i.action === 'string' && typeof i.at === 'string'
  );
}

export async function getHistory(area: LocalArea): Promise<HistoryItem[]> {
  const got = await area.get(HISTORY_KEY);
  const list = got[HISTORY_KEY];
  return Array.isArray(list) ? list.filter(valid).slice(0, HISTORY_LIMIT) : [];
}

/** Newest first, one entry per URL, at most HISTORY_LIMIT. */
export function withItem(list: HistoryItem[], item: HistoryItem): HistoryItem[] {
  return [item, ...list.filter((i) => i.url !== item.url)].slice(0, HISTORY_LIMIT);
}

export async function addHistory(area: LocalArea, item: HistoryItem): Promise<HistoryItem[]> {
  const next = withItem(await getHistory(area), item);
  await area.set({ [HISTORY_KEY]: next });
  return next;
}
