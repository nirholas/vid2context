/** Context menu ids and which URL a click refers to. */
import { isWebUrl } from '../lib/links.ts';

export const MENU_OPEN = 'v2c-open';
export const MENU_COPY_API = 'v2c-copy-api';
export const MENU_CONTEXTS = ['link', 'page', 'video'] as const;

export interface MenuClick {
  linkUrl?: string;
  srcUrl?: string;
  pageUrl?: string;
  mediaType?: string;
}

/**
 * The URL a menu click is about: the link, else the video's own source when it
 * is a real web URL (YouTube and most sites play blob: URLs, which mean
 * nothing outside the tab), else the page.
 */
export function menuTarget(info: MenuClick): string | null {
  if (isWebUrl(info.linkUrl)) return info.linkUrl;
  if (info.mediaType === 'video' && isWebUrl(info.srcUrl)) return info.srcUrl;
  if (isWebUrl(info.pageUrl)) return info.pageUrl;
  return null;
}
