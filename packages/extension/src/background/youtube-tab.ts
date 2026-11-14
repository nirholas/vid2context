/**
 * Step 2 of the bridge: open the video's watch page in a background tab (not
 * focused, muted), let the YouTube content script read the captions the way
 * "Copy for AI" does (the player response from the page, the caption track
 * with the page's cookies, and when the plain track URL comes back empty, the
 * proof-of-origin token the main-world script captures from the player's own
 * caption request), then close the tab: on success, on failure, after 45
 * seconds, or when the web page stops waiting.
 *
 * One tab at a time, so a page that sends many requests never opens many tabs.
 */
import { type ErrorCode, Vid2ContextError } from '@vid2context/core';
import type { ResultBody, TranscriptRequest } from '../lib/bridge-protocol.ts';
import { ext } from '../lib/browser.ts';
import type { BridgeTabResponse, ContentRequest } from '../lib/messages.ts';

export const TAB_TIMEOUT_MS = 45_000;
const RETRY_MS = 500;

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Ok = Extract<ResultBody, { ok: true }>;

/** Ask the tab's content script until it answers; before it has loaded, sendMessage fails and is retried. */
async function askTab(tabId: number, request: TranscriptRequest, stopped: () => boolean): Promise<Ok> {
  const msg: ContentRequest = { type: 'v2c:bridge-transcript', ...request };
  while (!stopped()) {
    let res: BridgeTabResponse | undefined;
    try {
      res = (await ext.tabs.sendMessage(tabId, msg)) as BridgeTabResponse | undefined;
    } catch {
      res = undefined;
    }
    if (stopped()) break;
    if (!res) {
      await sleep(RETRY_MS);
      continue;
    }
    if (res.ok) return { ok: true, transcript: res.transcript, ...(res.metadata ? { metadata: res.metadata } : {}) };
    throw new Vid2ContextError(res.code as ErrorCode, res.message, res.hint ? { hint: res.hint } : {});
  }
  throw new Vid2ContextError('timeout', 'Stopped waiting for the YouTube tab.');
}

async function openAndRead(request: TranscriptRequest, signal: AbortSignal, timeoutMs: number): Promise<Ok> {
  if (signal.aborted) throw new Vid2ContextError('timeout', 'The web page stopped waiting before the YouTube tab opened.');
  const tab = await ext.tabs.create({ url: watchUrl(request.videoId), active: false });
  const tabId = tab.id;
  if (tabId === undefined) throw new Vid2ContextError('unavailable', 'The browser did not open the YouTube tab.');
  ext.tabs.update(tabId, { muted: true }).catch(() => {});
  let settled = false;
  const cleanup: (() => void)[] = [];
  try {
    return await new Promise<Ok>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Vid2ContextError(
              'timeout',
              `YouTube did not deliver the captions in the background tab within ${Math.round(timeoutMs / 1000)} seconds.`,
            ),
          ),
        timeoutMs,
      );
      cleanup.push(() => clearTimeout(timer));
      const onRemoved = (id: number) => {
        if (id === tabId) reject(new Vid2ContextError('unavailable', 'The YouTube tab was closed before the captions arrived.'));
      };
      ext.tabs.onRemoved.addListener(onRemoved);
      cleanup.push(() => ext.tabs.onRemoved.removeListener(onRemoved));
      const onAbort = () => reject(new Vid2ContextError('timeout', 'The web page stopped waiting for the captions.'));
      signal.addEventListener('abort', onAbort, { once: true });
      cleanup.push(() => signal.removeEventListener('abort', onAbort));
      askTab(tabId, request, () => settled).then(resolve, reject);
    });
  } finally {
    settled = true;
    for (const fn of cleanup) fn();
    await ext.tabs.remove(tabId).catch(() => {});
  }
}

let queue: Promise<unknown> = Promise.resolve();

export function readViaTab(request: TranscriptRequest, signal: AbortSignal, timeoutMs = TAB_TIMEOUT_MS): Promise<Ok> {
  const run = queue.then(() => openAndRead(request, signal, timeoutMs));
  queue = run.catch(() => {});
  return run;
}
