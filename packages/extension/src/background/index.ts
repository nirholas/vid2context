/**
 * Service worker (Chrome, Edge) or event page (Firefox). Owns the context
 * menus, opens the web app, runs "Copy transcript (via API)" and answers the
 * web app bridge (bridge.ts).
 */
import { describeError, transcriptViaApi } from '../lib/api.ts';
import { ext } from '../lib/browser.ts';
import { addHistory, type HistoryAction } from '../lib/history.ts';
import { appLink, originPattern } from '../lib/links.ts';
import { settingsNow, settingsReady } from '../lib/live-settings.ts';
import { type BackgroundRequest, LAST_RESULT_KEY } from '../lib/messages.ts';
import { installBridge } from './bridge.ts';
import { type PageNotice, showPageNotice } from './inject.ts';
import { MENU_CONTEXTS, MENU_COPY_API, MENU_OPEN, menuTarget } from './menus.ts';

function remember(url: string, title: string, action: HistoryAction): void {
  void addHistory(ext.storage.local, { url, title, action, at: new Date().toISOString() }).catch(() => {});
}

async function openApp(url: string, title: string): Promise<void> {
  const settings = await settingsReady();
  await ext.tabs.create({ url: appLink(settings.appBase, url) });
  remember(url, title, 'open');
}

async function notify(tabId: number | undefined, notice: PageNotice): Promise<void> {
  if (tabId !== undefined && tabId >= 0) {
    try {
      await ext.scripting.executeScript({ target: { tabId }, func: showPageNotice, args: [notice] });
      await ext.storage.local.remove(LAST_RESULT_KEY);
      return;
    } catch {
      // The page does not allow scripts (browser pages, the web store): keep the result for the popup.
    }
  }
  await ext.storage.local.set({ [LAST_RESULT_KEY]: { ...notice, at: new Date().toISOString() } });
  await ext.action.setBadgeText({ text: '1', ...(tabId !== undefined && tabId >= 0 ? { tabId } : {}) });
}

interface PermissionAsk {
  pattern: string;
  result: Promise<boolean>;
}

async function copyViaApi(url: string, title: string, tabId: number | undefined, asked: PermissionAsk): Promise<void> {
  const settings = await settingsReady();
  const pattern = originPattern(settings.apiBase);
  const granted = (asked.pattern === pattern && (await asked.result)) || (await ext.permissions.contains({ origins: [pattern] }));
  if (!granted) {
    await notify(tabId, {
      kind: 'error',
      message: `vid2context needs permission to reach ${new URL(settings.apiBase).origin}.`,
      hint: 'Open the extension options, press "Allow API access", then try again.',
    });
    return;
  }
  try {
    const text = await transcriptViaApi(url, settings, fetch);
    await notify(tabId, { kind: 'ok', text, message: 'Transcript copied' });
    remember(url, title, 'api-copy');
  } catch (err) {
    await notify(tabId, { kind: 'error', ...describeError(err) });
  }
}

// Listeners are added synchronously at the top level, so events that wake the worker reach them.
installBridge();

ext.runtime.onInstalled.addListener(() => {
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create({ id: MENU_OPEN, title: 'Get context with vid2context', contexts: [...MENU_CONTEXTS] });
    ext.contextMenus.create({ id: MENU_COPY_API, title: 'Copy transcript (via API)', contexts: [...MENU_CONTEXTS] });
  });
});

ext.contextMenus.onClicked.addListener((info, tab) => {
  const url = menuTarget(info);
  if (!url) return;
  const title = info.linkUrl ? url : (tab?.title ?? url);
  if (info.menuItemId === MENU_OPEN) {
    void openApp(url, title);
    return;
  }
  if (info.menuItemId === MENU_COPY_API) {
    // Ask for the API host now, while the click still counts as a user action. Settings are
    // usually already loaded; right after the worker wakes, copyViaApi re-checks with fresh ones.
    const pattern = originPattern(settingsNow().apiBase);
    const result = ext.permissions.request({ origins: [pattern] }).catch(() => false);
    void copyViaApi(url, title, tab?.id, { pattern, result });
  }
});

ext.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (r: { ok: boolean }) => void) => {
  const msg = raw as BackgroundRequest;
  if (msg?.type === 'v2c:open-app') {
    openApp(msg.url, msg.title ?? msg.url).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  if (msg?.type === 'v2c:history') {
    remember(msg.url, msg.title, msg.action);
    sendResponse({ ok: true });
  }
  return false;
});
