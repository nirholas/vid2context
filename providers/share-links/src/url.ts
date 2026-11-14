/**
 * Recognise cloud share links without any network call.
 *
 *   gdrive    drive.google.com/file/d/<id>/..., open?id=, uc?id=, drive.usercontent.google.com/download?id=
 *   dropbox   dropbox.com/s/<id>/<name>, /scl/fi/<id>/<name>?rlkey=..., /e/scl/fi/...
 *   onedrive  1drv.ms/<t>/..., onedrive.live.com share and embed links, <tenant>.sharepoint.com/:<t>:/<g|s|t|p>/...
 *
 * Folder links (Drive folders, Dropbox /sh/ and /scl/fo/, OneDrive /f/) are
 * left to other sources: this provider handles one file per link.
 */
import type { VideoRef } from '@vid2context/core';

export type SharePlatform = 'gdrive' | 'dropbox' | 'onedrive';
export const SHARE_PLATFORMS: readonly SharePlatform[] = ['gdrive', 'dropbox', 'onedrive'];

const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com']);
const DRIVE_ID = /^[A-Za-z0-9_-]{25,}$/;
const DROPBOX_HOSTS = new Set(['dropbox.com', 'www.dropbox.com', 'dl.dropbox.com', 'dl.dropboxusercontent.com']);
const DROPBOX_ID = /^[A-Za-z0-9_-]{8,}$/;
const SHAREPOINT_HOST = /^[a-z0-9-]+\.sharepoint\.com$/;

function parseUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function ref(input: string, platform: SharePlatform, nativeId: string, url: string): VideoRef {
  return { input, platform, kind: 'video', id: `${platform}:${nativeId}`, nativeId, url };
}

function matchDrive(input: string, url: URL): VideoRef | null {
  // drive.google.com/u/0/uc?id=... carries an account index; drop it.
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'u' && /^\d+$/.test(parts[1] ?? '')) parts.splice(0, 2);
  let id: string | null = null;
  if (parts[0] === 'file' && parts[1] === 'd') id = parts[2] ?? null;
  else if (parts.length === 1 && ['open', 'uc', 'download'].includes(parts[0] ?? '')) id = url.searchParams.get('id');
  if (!id || !DRIVE_ID.test(id)) return null;
  const resourceKey = url.searchParams.get('resourcekey');
  const canonical = `https://drive.google.com/file/d/${id}/view${resourceKey ? `?resourcekey=${encodeURIComponent(resourceKey)}` : ''}`;
  return ref(input, 'gdrive', id, canonical);
}

function matchDropbox(input: string, url: URL): VideoRef | null {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'e') parts.shift();
  if (parts[0] === 's') {
    const id = parts[1];
    if (!id || !DROPBOX_ID.test(id)) return null;
    const name = parts.slice(2).join('/');
    return ref(input, 'dropbox', id, `https://www.dropbox.com/s/${id}${name ? `/${name}` : ''}`);
  }
  if (parts[0] === 'scl' && parts[1] === 'fi') {
    const id = parts[2];
    if (!id || !DROPBOX_ID.test(id)) return null;
    const name = parts.slice(3).join('/');
    const rlkey = url.searchParams.get('rlkey');
    const canonical = `https://www.dropbox.com/scl/fi/${id}${name ? `/${name}` : ''}${rlkey ? `?rlkey=${encodeURIComponent(rlkey)}` : ''}`;
    return ref(input, 'dropbox', id, canonical);
  }
  return null;
}

/** onedrive.live.com redirects carry the original share link base64-encoded in `redeem`. */
function decodeRedeem(value: string): string | null {
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    return /^https:\/\/1drv\.ms\//.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function matchOneDriveShort(input: string, url: URL): VideoRef | null {
  const parts = url.pathname.split('/').filter(Boolean);
  const [type] = parts;
  const token = parts[parts.length - 1];
  if (!type || type === 'f' || parts.length < 2 || !token) return null;
  return ref(input, 'onedrive', token, url.href);
}

function matchOneDriveLive(input: string, url: URL): VideoRef | null {
  const redeem = url.searchParams.get('redeem');
  if (redeem) {
    const shared = decodeRedeem(redeem);
    const inner = shared ? parseUrl(shared) : null;
    return inner ? matchOneDriveShort(input, inner) : null;
  }
  const resid = url.searchParams.get('resid') ?? url.searchParams.get('id');
  if (resid && (url.searchParams.has('authkey') || url.pathname.includes('embed') || url.pathname.includes('redir'))) {
    return ref(input, 'onedrive', resid, url.href);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (/^:[a-z]:$/.test(parts[0] ?? '') && parts[0] !== ':f:' && parts.length >= 3) {
    const token = parts[parts.length - 1];
    return token ? ref(input, 'onedrive', token, url.href) : null;
  }
  return null;
}

export interface SharePointLink {
  host: string;
  /** Site path before /_layouts: '', 'personal/<user>', 'sites/<site>' or 'teams/<team>'. */
  sitePath: string;
  token: string;
}

/** Split a SharePoint sharing link (`/:v:/s/<site>/<token>` and friends) into the parts the download endpoint needs. */
export function parseSharePoint(raw: string): SharePointLink | null {
  const url = parseUrl(raw);
  if (!url || !SHAREPOINT_HOST.test(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const [type, scope, ...rest] = parts;
  if (!type || !/^:[a-z]:$/.test(type) || type === ':f:') return null;
  const token = rest[rest.length - 1];
  let sitePath: string | null = null;
  if (scope === 'g' && rest.length === 1) sitePath = '';
  else if (scope === 'g' && rest[0] === 'personal' && rest.length === 3) sitePath = `personal/${rest[1]}`;
  else if (scope === 'p' && rest.length === 2) sitePath = `personal/${rest[0]}`;
  else if (scope === 's' && rest.length === 2) sitePath = `sites/${rest[0]}`;
  else if (scope === 't' && rest.length === 2) sitePath = `teams/${rest[0]}`;
  if (sitePath === null || !token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  return { host: url.hostname.toLowerCase(), sitePath, token };
}

/** Recognise a Google Drive, Dropbox, OneDrive or SharePoint file share link. Synchronous, no network. */
export function matchShareLink(raw: string): VideoRef | null {
  const input = raw.trim();
  if (!/[./]/.test(input)) return null;
  const url = parseUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (DRIVE_HOSTS.has(host)) return matchDrive(input, url);
  if (DROPBOX_HOSTS.has(host)) return matchDropbox(input, url);
  if (host === '1drv.ms') return matchOneDriveShort(input, url);
  if (host === 'onedrive.live.com') return matchOneDriveLive(input, url);
  if (SHAREPOINT_HOST.test(host)) {
    const sp = parseSharePoint(url.href);
    return sp ? ref(input, 'onedrive', sp.token, url.href) : null;
  }
  return null;
}
