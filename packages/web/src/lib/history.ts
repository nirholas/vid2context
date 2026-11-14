/**
 * Recent results, kept in this browser's IndexedDB database `v2c-web`. Each
 * entry stores the whole VideoContext so a result reopens instantly.
 */
import type { VideoContext } from '@vid2context/core';
import { openDb, promisify, txDone } from './idb.ts';

const DB = 'v2c-web';
const VERSION = 1;
const STORE = 'results';
/** Oldest entries beyond this are dropped on save. */
export const MAX_ENTRIES = 100;

/** Fired on `window` after any save, delete or clear, so every list of results can reload. */
export const HISTORY_EVENT = 'v2c:history';

function changed(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(HISTORY_EVENT));
}

export interface HistorySummary {
  /** runKey(input, mode, lang). */
  key: string;
  input: string;
  mode: string;
  lang: string;
  videoId: string;
  title: string;
  channel?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  /** Files in the result's bundle. */
  fileCount: number;
  /** Epoch milliseconds. */
  savedAt: number;
}

export interface HistoryEntry extends HistorySummary {
  context: VideoContext;
}

/** One cache key per request: the same link with another mode or language is another result. */
export function runKey(input: string, mode = 'auto', lang = ''): string {
  return `${mode || 'auto'}|${lang}|${input.trim()}`;
}

function db(): Promise<IDBDatabase> {
  return openDb(DB, VERSION, (d) => {
    if (!d.objectStoreNames.contains(STORE)) {
      const s = d.createObjectStore(STORE, { keyPath: 'key' });
      s.createIndex('savedAt', 'savedAt');
      s.createIndex('videoId', 'videoId');
    }
  });
}

export async function getEntry(key: string): Promise<HistoryEntry | undefined> {
  const d = await db();
  return (await promisify(d.transaction(STORE).objectStore(STORE).get(key))) as HistoryEntry | undefined;
}

export function summarize(
  context: VideoContext,
  req: { input: string; mode?: string; lang?: string },
  fileCount: number,
): HistoryEntry {
  const m = context.metadata;
  return {
    key: runKey(req.input, req.mode, req.lang),
    input: req.input.trim(),
    mode: req.mode || 'auto',
    lang: req.lang ?? '',
    videoId: m.ref.id,
    title: m.title,
    channel: m.channel?.name,
    thumbnailUrl: m.thumbnailUrl,
    durationSec: m.durationSec,
    fileCount,
    savedAt: Date.now(),
    context,
  };
}

/** Save a result. Older entries for the same video, mode and language are replaced. */
export async function putEntry(entry: HistoryEntry): Promise<void> {
  const d = await db();
  const tx = d.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const same = (await promisify(store.index('videoId').getAll(entry.videoId))) as HistoryEntry[];
  for (const old of same) {
    if (old.key !== entry.key && old.mode === entry.mode && old.lang === entry.lang) store.delete(old.key);
  }
  store.put(entry);
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = store.index('savedAt').openKeyCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      keys.push(c.primaryKey as string);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  for (const k of keys.slice(MAX_ENTRIES)) store.delete(k);
  await txDone(tx);
  changed();
}

/** Newest first, without the stored contexts. */
export async function listEntries(limit = 24): Promise<HistorySummary[]> {
  const d = await db();
  const store = d.transaction(STORE).objectStore(STORE);
  const out: HistorySummary[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = store.index('savedAt').openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= limit) return resolve();
      const { context: _context, ...summary } = c.value as HistoryEntry;
      out.push(summary);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out;
}

export async function countEntries(): Promise<number> {
  const d = await db();
  return promisify(d.transaction(STORE).objectStore(STORE).count());
}

export async function deleteEntry(key: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(key);
  await txDone(tx);
  changed();
}

export async function clearHistory(): Promise<void> {
  const d = await db();
  const tx = d.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await txDone(tx);
  changed();
}
