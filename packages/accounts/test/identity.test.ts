import { createHash, createHmac } from 'node:crypto';
import { MemoryKv } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { upsertGithubAccount } from '../src/accounts.ts';
import { createApiKey, deleteApiKey, listApiKeys, looksLikeApiKey, MAX_KEYS_PER_ACCOUNT, resolveApiKey } from '../src/apikeys.ts';
import { readHostedConfig, requireSessionSecret, safeLocalPath } from '../src/config.ts';
import { hmac, sign, unsign } from '../src/crypto.ts';
import { DEFAULT_PLANS, parsePlans } from '../src/plans.ts';
import { createSession, deleteSession, readSession } from '../src/sessions.ts';

const SECRET = 'unit-test-session-secret-with-more-than-32-chars';
// GitHub's public documentation account (https://api.github.com/users/octocat).
const OCTOCAT = { id: 583231, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' };

async function dump(kv: MemoryKv, prefix = ''): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of (await kv.kvList(prefix, { limit: 1000 })).keys) out[k] = await kv.kvGet(k);
  return out;
}

describe('cookie signing', () => {
  it('round-trips and rejects tampering', async () => {
    const signed = await sign(SECRET, 'session-id');
    expect(await unsign(SECRET, signed)).toBe('session-id');
    expect(await unsign('another-secret-with-more-than-32-characters', signed)).toBeNull();
    const [value, sig] = signed.split('.') as [string, string];
    expect(await unsign(SECRET, `${value}x.${sig}`)).toBeNull();
    expect(await unsign(SECRET, `${value}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(await unsign(SECRET, value)).toBeNull();
    // Matches an independent HMAC-SHA256 implementation.
    expect(await hmac(SECRET, 'session-id')).toBe(createHmac('sha256', SECRET).update('session-id').digest('base64url'));
  });
});

describe('sessions', () => {
  it('creates, reads, expires and deletes a session', async () => {
    const kv = new MemoryKv();
    const { cookie, record } = await createSession(kv, SECRET, 'acc_1', { ttlSec: 3600 });
    expect(await readSession(kv, SECRET, cookie)).toEqual(record);
    expect(record.accountId).toBe('acc_1');

    // The store keys sessions by the SHA-256 of the id, never the id itself.
    const id = cookie.slice(0, cookie.lastIndexOf('.'));
    const keys = Object.keys(await dump(kv, 'accounts:session:'));
    expect(keys).toEqual([`accounts:session:${createHash('sha256').update(id).digest('hex')}`]);
    expect(JSON.stringify(await dump(kv))).not.toContain(id);

    // Past its expiry the session is gone and its record removed.
    expect(await readSession(kv, SECRET, cookie, Date.parse(record.expiresAt) + 1)).toBeNull();
    expect(await dump(kv, 'accounts:session:')).toEqual({});

    const second = await createSession(kv, SECRET, 'acc_1', { ttlSec: 3600 });
    await deleteSession(kv, SECRET, second.cookie);
    expect(await readSession(kv, SECRET, second.cookie)).toBeNull();
  });

  it('refuses tampered, foreign and oversized cookies', async () => {
    const kv = new MemoryKv();
    const { cookie } = await createSession(kv, SECRET, 'acc_1', { ttlSec: 3600 });
    expect(await readSession(kv, SECRET, `${cookie}x`)).toBeNull();
    expect(await readSession(kv, 'a-different-secret-that-is-also-long-enough', cookie)).toBeNull();
    expect(await readSession(kv, SECRET, 'x'.repeat(300))).toBeNull();
    expect(await readSession(kv, SECRET, undefined)).toBeNull();
    // A correctly signed id that was never issued.
    expect(await readSession(kv, SECRET, await sign(SECRET, 'never-issued'))).toBeNull();
  });
});

describe('accounts', () => {
  it('stores only the GitHub id, login and avatar, never an email', async () => {
    const kv = new MemoryKv();
    const a = await upsertGithubAccount(kv, OCTOCAT, { plan: 'free' });
    expect(Object.keys(a).sort()).toEqual(['avatarUrl', 'createdAt', 'githubId', 'id', 'login', 'plan', 'updatedAt']);
    expect(a.id).toMatch(/^acc_[A-Za-z0-9_-]{22}$/);
    const stored = await dump(kv);
    expect(Object.keys(stored).sort()).toEqual([`accounts:account:${a.id}`, 'accounts:github:583231']);
    expect(JSON.stringify(stored)).not.toMatch(/email|@/i);

    // Signing in again keeps the id and plan and refreshes the login.
    const again = await upsertGithubAccount(kv, { ...OCTOCAT, login: 'octocat-renamed' }, { plan: 'other' });
    expect(again).toMatchObject({ id: a.id, plan: 'free', login: 'octocat-renamed', createdAt: a.createdAt });
  });
});

describe('API keys', () => {
  it('creates v2c_ keys from 32 random bytes and stores only their SHA-256', async () => {
    const kv = new MemoryKv();
    const { key, record } = await createApiKey(kv, 'acc_1', 'laptop');
    expect(key).toMatch(/^v2c_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key.slice(4), 'base64url')).toHaveLength(32);
    expect(looksLikeApiKey(key)).toBe(true);
    expect(record).toMatchObject({ accountId: 'acc_1', name: 'laptop', prefix: key.slice(0, 8) });

    const stored = await dump(kv);
    const hash = createHash('sha256').update(key).digest('hex');
    expect(Object.keys(stored)).toContain(`accounts:key:${hash}`);
    expect(JSON.stringify(stored)).not.toContain(key);

    const list = await listApiKeys(kv, 'acc_1');
    expect(list).toEqual([{ id: record.id, name: 'laptop', prefix: record.prefix, createdAt: record.createdAt }]);
    expect(await listApiKeys(kv, 'acc_2')).toEqual([]);
  });

  it('resolves keys, writes last-used at most hourly, and deletes them', async () => {
    const kv = new MemoryKv();
    const { key, record } = await createApiKey(kv, 'acc_1', 'ci');
    const t0 = Date.parse('2026-11-14T10:00:00Z');
    expect((await resolveApiKey(kv, key, t0))?.lastUsedAt).toBe('2026-11-14T10:00:00.000Z');
    expect((await resolveApiKey(kv, key, t0 + 10 * 60_000))?.lastUsedAt).toBe('2026-11-14T10:00:00.000Z');
    expect((await resolveApiKey(kv, key, t0 + 61 * 60_000))?.lastUsedAt).toBe('2026-11-14T11:01:00.000Z');

    expect(await resolveApiKey(kv, `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(await resolveApiKey(kv, 'not-a-key')).toBeNull();
    expect(await deleteApiKey(kv, 'acc_2', record.id)).toBe(false);
    expect(await deleteApiKey(kv, 'acc_1', record.id)).toBe(true);
    expect(await resolveApiKey(kv, key)).toBeNull();
    expect(await dump(kv)).toEqual({});
  });

  it('validates names and caps keys per account', async () => {
    const kv = new MemoryKv();
    await expect(createApiKey(kv, 'acc_1', '')).rejects.toMatchObject({ code: 'bad-request' });
    await expect(createApiKey(kv, 'acc_1', 'x'.repeat(65))).rejects.toMatchObject({ code: 'bad-request' });
    await expect(createApiKey(kv, 'acc_1', 42)).rejects.toMatchObject({ code: 'bad-request' });
    for (let i = 0; i < MAX_KEYS_PER_ACCOUNT; i++) await createApiKey(kv, 'acc_1', `key ${i}`);
    await expect(createApiKey(kv, 'acc_1', 'one more')).rejects.toMatchObject({ code: 'bad-request' });
  });
});

describe('plans and config', () => {
  it('parses VID2CONTEXT_PLANS over the defaults', () => {
    expect(parsePlans(undefined)).toEqual(DEFAULT_PLANS);
    const plans = parsePlans('{"free":{"requestsPerDay":10},"team":{"sttMinutesPerDay":600}}');
    expect(plans.free).toEqual({ ...DEFAULT_PLANS.free, requestsPerDay: 10 });
    expect(plans.team).toEqual({ ...DEFAULT_PLANS.free, sttMinutesPerDay: 600 });
    expect(plans.anonymous).toEqual(DEFAULT_PLANS.anonymous);
    expect(() => parsePlans('{')).toThrow(/not valid JSON/);
    expect(() => parsePlans('[]')).toThrow(/JSON object/);
    expect(() => parsePlans('{"free":{"tokens":1}}')).toThrow(/unknown field/);
    expect(() => parsePlans('{"free":{"requestsPerDay":-1}}')).toThrow(/0 or more/);
    expect(() => parsePlans('{"Bad Name":{}}')).toThrow(/invalid plan name/);
  });

  it('reads hosted settings from env and guards redirects', () => {
    const off = readHostedConfig({});
    expect(off).toMatchObject({ hosted: false, anonymous: false, sharedCachePlatforms: ['youtube'], sharedCacheTtlSec: 30 * 86_400 });
    expect(() => requireSessionSecret(off)).toThrow(/VID2CONTEXT_SESSION_SECRET/);
    const on = readHostedConfig({
      VID2CONTEXT_HOSTED: '1',
      VID2CONTEXT_SESSION_SECRET: SECRET,
      GITHUB_OAUTH_CLIENT_ID: 'id',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
      VID2CONTEXT_SHARED_CACHE_PLATFORMS: 'youtube, Vimeo',
    });
    expect(on.github).toEqual({ clientId: 'id', clientSecret: 'secret', redirectUri: undefined });
    expect(on.sharedCachePlatforms).toEqual(['youtube', 'vimeo']);
    expect(requireSessionSecret(on)).toBe(SECRET);
    expect(() => readHostedConfig({ VID2CONTEXT_IP_BURST: 'lots' })).toThrow(/VID2CONTEXT_IP_BURST/);

    expect(safeLocalPath('/app/?x=1')).toBe('/app/?x=1');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'app', '/a\nb', undefined]) {
      expect(safeLocalPath(bad)).toBeNull();
    }
  });
});
