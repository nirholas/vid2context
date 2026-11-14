/** Talk to the YouTube content script in a tab, injecting it first when the tab was open before the extension loaded. */
import { ext } from '../lib/browser.ts';
import type { ContentRequest, ContentResponse } from '../lib/messages.ts';

export async function sendToContent(tabId: number, msg: ContentRequest): Promise<ContentResponse> {
  try {
    return (await ext.tabs.sendMessage(tabId, msg)) as ContentResponse;
  } catch {
    await ext.scripting.executeScript({ target: { tabId }, files: ['page.js'], world: 'MAIN' });
    await ext.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return (await ext.tabs.sendMessage(tabId, msg)) as ContentResponse;
  }
}

export interface ActiveTab {
  id?: number;
  url?: string;
  title?: string;
}

export async function activeTab(): Promise<ActiveTab> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id, url: tab?.url, title: tab?.title };
}
