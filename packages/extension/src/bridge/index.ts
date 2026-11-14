/**
 * Content script on the vid2context web app's origins (manifest and
 * user-added origins). It lets the web app ask the extension for a YouTube
 * transcript, which the extension fetches from the user's own IP address.
 *
 * It answers `ping` with `pong`, posts one unprompted `pong` when it loads,
 * and relays `youtube-transcript` requests to the background over a runtime
 * Port, posting each progress message and the one result back to the page.
 * Messages from other windows, other origins or with unknown shapes are
 * ignored. See docs/contracts/transcript-import.md.
 */

import {
  BRIDGE_PORT,
  type BridgeError,
  type ExtensionMessage,
  eventData,
  type PortReply,
  type PortRequest,
  parseWebMessage,
  pongMessage,
  progressMessage,
  resultMessage,
  type TranscriptRequest,
} from '../lib/bridge-protocol.ts';
import { ext } from '../lib/browser.ts';

const LOADED = '__vid2contextBridge';

function post(msg: ExtensionMessage): void {
  window.postMessage(msg, location.origin);
}

function version(): string {
  return ext.runtime.getManifest().version;
}

const STOPPED: BridgeError = {
  code: 'unavailable',
  message: 'The vid2context extension stopped before it answered.',
  hint: 'Reload this page and try again. If the extension was just updated or reloaded, the page needs a reload to reach it.',
};

function relay(id: string, request: TranscriptRequest): void {
  let done = false;
  const finish = (error: BridgeError) => {
    if (done) return;
    done = true;
    post(resultMessage(id, { ok: false, error }));
  };
  let port: chrome.runtime.Port;
  try {
    port = ext.runtime.connect({ name: BRIDGE_PORT });
  } catch {
    finish(STOPPED);
    return;
  }
  port.onMessage.addListener((raw: unknown) => {
    if (done) return;
    const reply = raw as PortReply;
    if (reply?.type === 'progress') post(progressMessage(id, reply.stage, reply.message));
    else if (reply?.type === 'result') {
      done = true;
      post(resultMessage(id, reply.body));
      port.disconnect();
    }
  });
  port.onDisconnect.addListener(() => finish(STOPPED));
  const msg: PortRequest = { type: 'youtube-transcript', ...request };
  port.postMessage(msg);
}

function onMessage(event: MessageEvent): void {
  const msg = parseWebMessage(eventData(event, { window, origin: location.origin }));
  if (!msg) return;
  if (msg.kind === 'ping') post(pongMessage(version(), msg.id));
  else if (msg.kind === 'invalid') post(resultMessage(msg.id, { ok: false, error: msg.error }));
  else relay(msg.id, msg.request);
}

// The script can be injected twice into one page (a manifest match and a registered origin); listen once.
const flags = globalThis as { [LOADED]?: boolean };
if (!flags[LOADED]) {
  flags[LOADED] = true;
  window.addEventListener('message', onMessage);
  post(pongMessage(version()));
}
