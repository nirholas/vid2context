/**
 * The background side of the web app bridge: answers `youtube-transcript`
 * requests that bridge.js forwards over a runtime Port (the open Port also
 * keeps Chrome's service worker alive while a request runs), and keeps the
 * bridge registered on user-added origins.
 *
 * Order (docs/contracts/transcript-import.md):
 *   1. direct: the YouTube provider's innertube player and timedtext calls
 *      from here, with the user's IP address (youtube/direct.ts)
 *   2. tab: a background YouTube tab whose content script reads the captions
 *      the way the player does (youtube-tab.ts)
 */
import { createContext } from '@vid2context/core';
import { BRIDGE_HINTS, bridgeError, finalError, toBridgeError } from '../lib/bridge-errors.ts';
import {
  BRIDGE_ORIGINS_KEY,
  BRIDGE_SCRIPT_ID,
  bridgeRegistration,
  loadBridgeOrigins,
  registrationPlan,
} from '../lib/bridge-origins.ts';
import {
  BRIDGE_PORT,
  type PortReply,
  parsePortRequest,
  type ResultBody,
  type TranscriptRequest,
} from '../lib/bridge-protocol.ts';
import { ext } from '../lib/browser.ts';
import { originPattern } from '../lib/links.ts';
import { fetchDirect, type Progress } from '../youtube/direct.ts';
import { ensureYouTubeOriginRule } from './youtube-origin.ts';
import { readViaTab } from './youtube-tab.ts';

/** Time for step 1, so step 2 (45 s) still fits in the web app's 90 s. */
export const DIRECT_BUDGET_MS = 30_000;

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/**
 * The extension's fetch for the provider. Caption downloads carry the user's
 * YouTube cookies, like the player's own. innertube calls go without them:
 * the provider speaks as the ANDROID and IOS apps, which do not use web
 * session cookies.
 */
export const extensionFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, credentials: urlOf(input).includes('/api/timedtext') ? 'include' : 'omit' });

function withBudget(signal: AbortSignal, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('The direct request took too long.', 'TimeoutError')), ms);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

export async function youtubeTranscript(
  request: TranscriptRequest,
  progress: Progress,
  signal: AbortSignal,
): Promise<ResultBody> {
  await ensureYouTubeOriginRule();
  const budget = withBudget(signal, DIRECT_BUDGET_MS);
  let direct: Awaited<ReturnType<typeof fetchDirect>>;
  try {
    direct = await fetchDirect(
      request,
      createContext({ runtime: 'browser', fetch: extensionFetch, signal: budget.signal }),
      progress,
    );
  } finally {
    budget.done();
  }
  if (direct.kind === 'ok') return direct.body;
  if (direct.kind === 'final') return { ok: false, error: direct.error };
  if (signal.aborted) return { ok: false, error: bridgeError('timeout', 'The web page stopped waiting.') };

  progress('tab', 'Reading the captions from a YouTube tab opened in the background. It closes by itself.');
  try {
    return await readViaTab(request, signal);
  } catch (err) {
    return { ok: false, error: finalError(toBridgeError(err), direct.reason) };
  }
}

function onBridgePort(port: chrome.runtime.Port): void {
  if (port.name !== BRIDGE_PORT) return;
  if (port.sender?.id !== ext.runtime.id) {
    port.disconnect();
    return;
  }
  const controller = new AbortController();
  let open = true;
  let started = false;
  port.onDisconnect.addListener(() => {
    open = false;
    controller.abort();
  });
  const send = (reply: PortReply) => {
    if (!open) return;
    try {
      port.postMessage(reply);
    } catch {
      open = false;
    }
  };
  port.onMessage.addListener((raw: unknown) => {
    if (started) return;
    started = true;
    const request = parsePortRequest(raw);
    if ('code' in request) {
      send({ type: 'result', body: { ok: false, error: request } });
      return;
    }
    youtubeTranscript(request, (stage, message) => send({ type: 'progress', stage, message }), controller.signal)
      .catch((err: unknown): ResultBody => ({ ok: false, error: { ...toBridgeError(err), hint: BRIDGE_HINTS.unavailable } }))
      .then((body) => send({ type: 'result', body }));
  });
}

// ---------------------------------------------------------------- user-added origins

let syncing: Promise<void> = Promise.resolve();

async function syncOnce(): Promise<void> {
  const origins = await loadBridgeOrigins(ext.storage.local);
  const granted: string[] = [];
  for (const origin of origins) {
    const pattern = originPattern(origin);
    if (await ext.permissions.contains({ origins: [pattern] })) granted.push(pattern);
  }
  const [existing] = await ext.scripting.getRegisteredContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
  const plan = registrationPlan(existing, bridgeRegistration(granted));
  if (plan.unregister) await ext.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
  if (plan.register) await ext.scripting.registerContentScripts([plan.register]);
}

/** Register bridge.js on the stored origins the extension may run on. Runs one at a time. */
export function syncBridgeScripts(): Promise<void> {
  syncing = syncing.then(syncOnce).catch((err: unknown) => console.error('vid2context: could not register the bridge', err));
  return syncing;
}

export function installBridge(): void {
  ext.runtime.onConnect.addListener(onBridgePort);
  ext.runtime.onStartup.addListener(() => void syncBridgeScripts());
  ext.runtime.onInstalled.addListener(() => void syncBridgeScripts());
  ext.permissions.onAdded.addListener(() => void syncBridgeScripts());
  ext.permissions.onRemoved.addListener(() => void syncBridgeScripts());
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[BRIDGE_ORIGINS_KEY]) void syncBridgeScripts();
  });
}
