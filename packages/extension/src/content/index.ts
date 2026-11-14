/**
 * Content script for YouTube watch pages. Adds "Copy for AI", "Download .zip"
 * and "Open in vid2context" under the title, keeps them through YouTube's
 * single-page navigation, and answers the popup. Captions are fetched and
 * formatted right here in the page: nothing goes to a server.
 */
import { buildBundle, collectBytes, estimateTokens, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { describeError } from '../lib/api.ts';
import { ext } from '../lib/browser.ts';
import { addHistory, type HistoryAction } from '../lib/history.ts';
import { youtubeWatchId } from '../lib/links.ts';
import { settingsNow, settingsReady } from '../lib/live-settings.ts';
import type { BackgroundRequest, BridgeTabResponse, ContentRequest, ContentResponse } from '../lib/messages.ts';
import { renderForCopy } from '../youtube/copy.ts';
import { bridgeTranscriptFor, contextFor, hasCaptions, NO_CAPTIONS_HINT, playerFor } from './extract.ts';
import { createActionsUi, HOST_ID } from './ui.ts';

/** Where the buttons go: desktop title, then the mobile site's title block. */
const ANCHORS = ['ytd-watch-metadata #title', '#above-the-fold #title', 'ytm-slim-video-information-renderer'];

const ui = createActionsUi({ zip: true });
let videoId: string | null = null;
let pending: Promise<VideoContext> | null = null;
let ready: VideoContext | null = null;

function anchor(): Element | null {
  for (const sel of ANCHORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function mount(): void {
  const a = anchor();
  if (!a) return;
  for (const el of Array.from(document.querySelectorAll(`#${HOST_ID}`))) if (el !== ui.host) el.remove();
  if (!ui.host.isConnected || ui.host.previousElementSibling !== a) a.insertAdjacentElement('afterend', ui.host);
}

function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

function remember(action: HistoryAction, title: string): void {
  if (!videoId) return;
  void addHistory(ext.storage.local, { url: watchUrl(videoId), title, action, at: new Date().toISOString() }).catch(() => {});
}

async function checkCaptions(id: string): Promise<void> {
  try {
    const player = await playerFor(id);
    if (id !== videoId) return;
    const available = hasCaptions(player);
    ui.setCaptions(available);
    if (!available) ui.setStatus('info', 'This video has no captions.', NO_CAPTIONS_HINT);
  } catch {
    // Leave the buttons enabled; a click reports the real error.
  }
}

function sync(): void {
  const id = youtubeWatchId(location.href);
  if (!id) {
    videoId = null;
    for (const el of Array.from(document.querySelectorAll(`#${HOST_ID}`))) el.remove();
    return;
  }
  if (id !== videoId) {
    videoId = id;
    pending = null;
    ready = null;
    ui.clearStatus();
    ui.setCaptions(true);
    void checkCaptions(id);
  }
  mount();
}

function loadContext(): Promise<VideoContext> {
  const id = videoId;
  if (!id) return Promise.reject(new Error('Not on a YouTube watch page.'));
  if (ready && ready.metadata.ref.nativeId === id) return Promise.resolve(ready);
  if (!pending) {
    pending = contextFor(id).then(
      (c) => {
        if (id === videoId) ready = c;
        return c;
      },
      (err) => {
        pending = null;
        throw err;
      },
    );
  }
  return pending;
}

function copyText(context: VideoContext): { text: string; via: string } {
  return renderForCopy(context, settingsNow());
}

async function onCopy(): Promise<void> {
  ui.setBusy(ui.copy, true, 'Copying...');
  try {
    await settingsReady();
    const context = await loadContext();
    const { text, via } = copyText(context);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ui.setStatus(
        'info',
        'Ready. Click "Copy for AI" again to copy it.',
        'The browser only allows copying right after a click.',
      );
      return;
    }
    const what = via === 'agentPrompt' ? 'agent prompt' : via;
    ui.setStatus('ok', `Copied: ${what}, about ${estimateTokens(text).toLocaleString('en-US')} tokens.`);
    remember('copy', context.metadata.title);
  } catch (err) {
    const d = describeError(err);
    ui.setStatus('error', d.message, d.hint);
  } finally {
    ui.setBusy(ui.copy, false);
  }
}

async function downloadZip(): Promise<VideoContext> {
  const context = await loadContext();
  const bundle = await buildBundle([context]);
  const bytes = await collectBytes(bundle.zip());
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = bundle.filename;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  remember('zip', context.metadata.title);
  return context;
}

async function onZip(): Promise<void> {
  ui.setBusy(ui.zip, true, 'Building...');
  try {
    const context = await downloadZip();
    ui.setStatus('ok', `Downloaded the bundle for "${context.metadata.title}".`);
  } catch (err) {
    const d = describeError(err);
    ui.setStatus('error', d.message, d.hint);
  } finally {
    ui.setBusy(ui.zip, false);
  }
}

function onOpen(): void {
  if (!videoId) return;
  const title = ready?.metadata.title ?? document.title.replace(/ - YouTube$/, '');
  const msg: BackgroundRequest = { type: 'v2c:open-app', url: watchUrl(videoId), title };
  ext.runtime.sendMessage(msg).catch((err: unknown) => {
    const d = describeError(err);
    ui.setStatus('error', 'The extension was updated or reloaded.', `Reload this page to use it again. (${d.message})`);
  });
}

ui.copy.addEventListener('click', () => void onCopy());
ui.zip.addEventListener('click', () => void onZip());
ui.open.addEventListener('click', onOpen);

function answerBridge(msg: Extract<ContentRequest, { type: 'v2c:bridge-transcript' }>, send: (r: BridgeTabResponse) => void) {
  const request = { videoId: msg.videoId, ...(msg.language ? { language: msg.language } : {}) };
  bridgeTranscriptFor(request).then(
    (body) => send(body),
    (err: unknown) => {
      const code = err instanceof Vid2ContextError ? err.code : 'upstream';
      send({ ok: false, code, ...describeError(err) });
    },
  );
}

ext.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (r: ContentResponse | BridgeTabResponse) => void) => {
  const msg = raw as ContentRequest;
  if (msg?.type === 'v2c:bridge-transcript') {
    // Only the background asks this (it has no tab); a request from another page is ignored.
    if (sender.id !== ext.runtime.id || sender.tab) return false;
    answerBridge(msg, sendResponse);
    return true;
  }
  const fail = (err: unknown) => sendResponse({ ok: false, ...describeError(err) });
  if (msg?.type === 'v2c:status') {
    const id = youtubeWatchId(location.href);
    if (!id) {
      sendResponse({ ok: true });
      return false;
    }
    playerFor(id).then(
      (p) => sendResponse({ ok: true, videoId: id, title: p.videoDetails?.title, hasCaptions: hasCaptions(p) }),
      fail,
    );
    return true;
  }
  if (msg?.type === 'v2c:build-copy') {
    settingsReady()
      .then(() => loadContext())
      .then((c) => {
        const { text, via } = copyText(c);
        remember('copy', c.metadata.title);
        sendResponse({ ok: true, text, via, title: c.metadata.title });
      }, fail);
    return true;
  }
  if (msg?.type === 'v2c:download-zip') {
    downloadZip().then((c) => sendResponse({ ok: true, title: c.metadata.title }), fail);
    return true;
  }
  return false;
});

let scheduled = false;
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    sync();
  }, 250);
}

document.addEventListener('yt-navigate-finish', () => sync());
window.addEventListener('popstate', schedule);
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
sync();
