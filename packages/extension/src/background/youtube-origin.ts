/**
 * innertube refuses requests whose Origin is an extension: on 2026-11-14,
 * `POST /youtubei/v1/player` answered HTTP 403 (a "Sorry..." page) to
 * `Origin: chrome-extension://...` and `Origin: moz-extension://...`, and 200
 * with captions to `Origin: https://www.youtube.com` or no Origin, from the
 * same IP address. The YouTube provider already sends
 * `origin: https://www.youtube.com`, but in a browser Origin is a forbidden
 * header: fetch drops it and sends the extension's own origin instead.
 *
 * This session rule puts the provider's header back, only on requests this
 * extension's background makes to www.youtube.com (`tabIds: [-1]` excludes
 * every tab, `initiatorDomains` excludes other initiators). It needs the
 * `declarativeNetRequestWithHostAccess` permission, which adds no install
 * warning and works only on hosts the extension already has (youtube.com).
 */
import { ext } from '../lib/browser.ts';

export const YOUTUBE_ORIGIN_RULE_ID = 1;
const TAB_ID_NONE = -1;

export function youtubeOriginRule(extensionHost: string): chrome.declarativeNetRequest.Rule {
  return {
    id: YOUTUBE_ORIGIN_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: 'origin',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: 'https://www.youtube.com',
        },
      ],
    },
    condition: {
      requestDomains: ['www.youtube.com'],
      initiatorDomains: [extensionHost],
      tabIds: [TAB_ID_NONE],
      resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}

/** The host of this extension's own origin: the id on Chrome, the per-install UUID on Firefox. */
export function extensionHost(): string {
  return new URL(ext.runtime.getURL('/')).hostname;
}

/**
 * Install (or refresh) the rule. Session rules last until the browser closes,
 * so this runs before every direct fetch; it is cheap and idempotent. A
 * failure is logged and the direct fetch still runs: without the rule YouTube
 * may refuse it, and the YouTube tab takes over.
 */
export async function ensureYouTubeOriginRule(): Promise<boolean> {
  try {
    await ext.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [YOUTUBE_ORIGIN_RULE_ID],
      addRules: [youtubeOriginRule(extensionHost())],
    });
    return true;
  } catch (err) {
    console.error('vid2context: could not set the YouTube Origin rule', err);
    return false;
  }
}
