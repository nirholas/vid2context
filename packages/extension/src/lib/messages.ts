/** Messages between the popup, the service worker and the YouTube content script. */
import type { HistoryAction } from './history.ts';

/** Popup or service worker to the YouTube content script. */
export type ContentRequest =
  /** Build the copy text and return it (the popup writes the clipboard, since it has focus). */
  | { type: 'v2c:build-copy' }
  /** Build the bundle and start the download in the page. */
  | { type: 'v2c:download-zip' }
  /** What the page offers right now. */
  | { type: 'v2c:status' };

export type ContentResponse =
  | { ok: true; text?: string; via?: string; title?: string; hasCaptions?: boolean; videoId?: string }
  | { ok: false; message: string; hint?: string };

/** Content script or popup to the service worker. */
export type BackgroundRequest =
  | { type: 'v2c:open-app'; url: string; title?: string }
  | { type: 'v2c:history'; url: string; title: string; action: HistoryAction };

/** Main-world page script <-> isolated content script, over window.postMessage. */
export const PAGE_CHANNEL = 'vid2context-extension';

export type PageRequest =
  | { channel: typeof PAGE_CHANNEL; dir: 'req'; id: number; op: 'player'; videoId: string }
  | { channel: typeof PAGE_CHANNEL; dir: 'req'; id: number; op: 'pot'; videoId: string; languageCode: string };

export interface PageResponse {
  channel: typeof PAGE_CHANNEL;
  dir: 'res';
  id: number;
  /** For `player`: the player response object. For `pot`: a timedtext URL that carries the token. */
  value: unknown;
}

/** `storage.local` key for a context-menu result that could not be shown in the tab (browser pages, the web store). */
export const LAST_RESULT_KEY = 'lastResult';
