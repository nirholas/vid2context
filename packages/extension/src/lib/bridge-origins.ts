/**
 * Web app origins for the bridge content script beyond the built-in ones
 * (WEB_APP_MATCHES in the manifest): a self-hosted vid2context, for example.
 *
 * The options page asks for the optional host permission and stores the
 * origin in `storage.local` (permissions belong to this install, so the list
 * is not synced). The background keeps one registered content script
 * (BRIDGE_SCRIPT_ID) whose matches are the stored origins it holds the
 * permission for, and re-checks on startup, on install and whenever the list
 * or the permissions change. Match patterns ignore ports, so one entry
 * covers every port of a host.
 */
import { WEB_APP_MATCHES } from '../manifest.ts';
import { originPattern } from './links.ts';

export const BRIDGE_ORIGINS_KEY = 'bridgeOrigins';
export const BRIDGE_SCRIPT_ID = 'v2c-bridge-origins';

export type OriginInput = { ok: true; origin: string; pattern: string } | { ok: false; message: string };

/** Does a built-in match pattern (`scheme://host/*`, `scheme://*.host/*`) cover this URL? */
export function patternCovers(pattern: string, url: URL): boolean {
  const m = /^(https?):\/\/(\*\.)?([^/]+)\/\*$/.exec(pattern);
  if (!m) return false;
  const [, scheme, wildcard, host] = m;
  if (url.protocol !== `${scheme}:`) return false;
  if (url.hostname === host) return true;
  return Boolean(wildcard) && url.hostname.endsWith(`.${host}`);
}

export function builtInCovers(url: URL): boolean {
  return WEB_APP_MATCHES.some((p) => patternCovers(p, url));
}

/** Turn what the user typed into an origin and its match pattern, or say what is wrong with it. */
export function parseOriginInput(raw: string): OriginInput {
  const text = raw.trim();
  if (!text) return { ok: false, message: 'Enter the address of your vid2context web app.' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, message: 'Enter an http or https address, for example https://v2c.example.org.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, message: 'Only http and https addresses can run the web app.' };
  }
  if (!url.hostname) return { ok: false, message: 'The address needs a host name.' };
  if (builtInCovers(url)) {
    return {
      ok: false,
      message: `${url.origin} is already connected: the extension always runs on vid2context.com, localhost and 127.0.0.1.`,
    };
  }
  return { ok: true, origin: url.origin, pattern: originPattern(url.origin) };
}

/** Stored origins, cleaned: valid, not built in, one per match pattern. */
export function normalizeOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const parsed = parseOriginInput(item);
    if (!parsed.ok || seen.has(parsed.pattern)) continue;
    seen.add(parsed.pattern);
    out.push(parsed.origin);
  }
  return out;
}

export function addOrigin(list: string[], origin: string): { list: string[]; added: boolean } {
  const pattern = originPattern(origin);
  if (list.some((o) => originPattern(o) === pattern)) return { list, added: false };
  return { list: [...list, origin], added: true };
}

export function removeOrigin(list: string[], origin: string): string[] {
  const pattern = originPattern(origin);
  return list.filter((o) => originPattern(o) !== pattern);
}

type LocalArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export async function loadBridgeOrigins(area: LocalArea): Promise<string[]> {
  const got = await area.get(BRIDGE_ORIGINS_KEY);
  return normalizeOrigins(got[BRIDGE_ORIGINS_KEY]);
}

export async function saveBridgeOrigins(area: LocalArea, list: string[]): Promise<string[]> {
  const clean = normalizeOrigins(list);
  await area.set({ [BRIDGE_ORIGINS_KEY]: clean });
  return clean;
}

export interface BridgeScript {
  id: string;
  matches: string[];
  js: string[];
  runAt: 'document_idle';
  persistAcrossSessions: boolean;
}

/** The content script to register for these granted patterns, or null when there are none. */
export function bridgeRegistration(grantedPatterns: string[]): BridgeScript | null {
  const matches = [...new Set(grantedPatterns)].sort();
  if (matches.length === 0) return null;
  return { id: BRIDGE_SCRIPT_ID, matches, js: ['bridge.js'], runAt: 'document_idle', persistAcrossSessions: true };
}

export interface RegisteredLike {
  id: string;
  matches?: string[];
  js?: string[];
}

/** What to do to get from the registered script (if any) to the wanted one. */
export function registrationPlan(
  existing: RegisteredLike | undefined,
  wanted: BridgeScript | null,
): { unregister: boolean; register: BridgeScript | null } {
  if (!wanted) return { unregister: Boolean(existing), register: null };
  if (!existing) return { unregister: false, register: wanted };
  const same =
    JSON.stringify([...(existing.matches ?? [])].sort()) === JSON.stringify(wanted.matches) &&
    JSON.stringify(existing.js ?? []) === JSON.stringify(wanted.js);
  return same ? { unregister: false, register: null } : { unregister: true, register: wanted };
}
