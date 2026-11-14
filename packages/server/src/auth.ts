/**
 * API keys. VID2CONTEXT_API_KEYS is a comma-separated list. Each entry is
 * either a plain key (full access, as the contract has always said) or a
 * hashed entry `name:scope:sha256hex`, where the hex is the SHA-256 of the
 * key and scope is `read`, `write` or `admin`. Hashed entries keep the keys
 * themselves out of the server's config: generate one with
 *
 *   printf %s "$KEY" | sha256sum
 *
 * Presented keys are hashed and compared in constant time against every
 * entry, so neither timing nor an early exit reveals which entry matched.
 */
import { HttpError } from './errors.ts';

export type Scope = 'read' | 'write' | 'admin';

export interface ApiKeyEntry {
  /** Shown in access logs instead of the key. Plain keys are named `key-1`, `key-2`, ... by position. */
  name: string;
  scope: Scope;
  /** SHA-256 of the key, 32 bytes. */
  hash: Uint8Array;
}

export interface Principal {
  name: string;
  scope: Scope;
}

const HASHED = /^([A-Za-z0-9_.@-]{1,64}):(read|write|admin):([0-9a-fA-F]{64})$/;
const RANK: Record<Scope, number> = { read: 0, write: 1, admin: 2 };

const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Compare two 32-byte digests without branching on their contents. */
export function digestEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < 32; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Parse VID2CONTEXT_API_KEYS. Duplicate names get a numeric suffix so logs stay unambiguous. */
export async function parseApiKeys(raw: string): Promise<ApiKeyEntry[]> {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const entries: ApiKeyEntry[] = [];
  const names = new Set<string>();
  let plain = 0;
  for (const part of parts) {
    const m = HASHED.exec(part);
    let entry: ApiKeyEntry;
    if (m) {
      entry = { name: m[1] as string, scope: m[2] as Scope, hash: hexBytes((m[3] as string).toLowerCase()) };
    } else {
      plain += 1;
      entry = { name: `key-${plain}`, scope: 'admin', hash: await sha256(part) };
    }
    let name = entry.name;
    for (let n = 2; names.has(name); n++) name = `${entry.name}-${n}`;
    names.add(name);
    entries.push({ ...entry, name });
  }
  return entries;
}

const cache = new Map<string, Promise<ApiKeyEntry[]>>();

/** parseApiKeys, memoised per distinct config string (hashing every plain key on every request is wasted work). */
export function apiKeysFor(raw: string): Promise<ApiKeyEntry[]> {
  let hit = cache.get(raw);
  if (!hit) {
    if (cache.size > 16) cache.clear();
    hit = parseApiKeys(raw);
    cache.set(raw, hit);
  }
  return hit;
}

const AUTH_HEADERS = { 'www-authenticate': 'Bearer realm="vid2context"' };

/** The principal for an Authorization header, or an `unauthorized` HttpError. */
export async function authenticate(header: string | undefined, entries: ApiKeyEntry[]): Promise<Principal> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!m) {
    throw new HttpError('unauthorized', 401, 'This server requires an API key.', {
      hint: 'Send the header "Authorization: Bearer <key>". Ask the server operator for a key.',
      headers: AUTH_HEADERS,
    });
  }
  const presented = await sha256(m[1] as string);
  let found: ApiKeyEntry | undefined;
  for (const entry of entries) {
    // Every entry is compared, match or not, so timing does not depend on the position of the match.
    if (digestEqual(presented, entry.hash) && !found) found = entry;
  }
  if (!found) {
    throw new HttpError('unauthorized', 401, 'The API key is not valid.', {
      hint: 'Check the key for typos or ask the server operator for a new one.',
      headers: AUTH_HEADERS,
    });
  }
  return { name: found.name, scope: found.scope };
}

/**
 * POST routes that only read: they compute an answer from videos and store
 * nothing, so a `read` key may call them. Paths are relative to /api/v1.
 */
const READ_ONLY_POSTS = new Set(['/pack', '/bundle', '/ask', '/chat', '/research', '/duplicates', '/exports/obsidian']);

/** The scope a request needs: `read` for GET, HEAD and read-only POSTs, `write` for everything that stores, changes or deletes. */
export function requiredScope(method: string, path: string): Scope {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'read';
  const rel = path.startsWith('/api/v1') ? path.slice('/api/v1'.length) || '/' : path;
  if (m === 'POST' && READ_ONLY_POSTS.has(rel.replace(/\/+$/, ''))) return 'read';
  return 'write';
}

export function assertScope(principal: Principal, needed: Scope, method: string, path: string): void {
  if (RANK[principal.scope] >= RANK[needed]) return;
  throw new HttpError('forbidden', 403, `The key "${principal.name}" has scope "${principal.scope}"; ${method} ${path} needs "${needed}".`, {
    hint: `Use a key with the "${needed}" scope (or "admin").`,
  });
}
