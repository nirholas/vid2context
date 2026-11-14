/**
 * OAuth state in a KvStore under `auth:oauth:` keys, every entry with a TTL.
 * Codes and tokens are stored under the SHA-256 of their value, so a leaked
 * store does not leak usable credentials. Refresh tokens rotate on every use;
 * presenting a rotated-out refresh token revokes its whole token family (the
 * reuse detection OAuth 2.1 recommends for public clients).
 */
import type { KvStore } from '@vid2context/core';
import { randomToken, sha256Hex } from './crypto.ts';

const P = 'auth:oauth:';

export type TokenEndpointAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface ClientRecord {
  clientId: string;
  clientName?: string;
  clientUri?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  /** SHA-256 hex of the client secret, for confidential clients. */
  secretHash?: string;
  /** 'dcr' for RFC 7591 registrations, 'cimd' for a Client ID Metadata Document fetched from client_id. */
  kind: 'dcr' | 'cimd';
  createdAt: number;
}

export interface AuthRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  resource: string;
  /** SHA-256 hex of the CSRF token that must come back in the form and the cookie. */
  csrfHash: string;
}

export interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

export interface TokenRecord {
  clientId: string;
  scope: string;
  resource: string;
  familyId: string;
  /** Epoch ms. */
  expiresAt: number;
}

interface FamilyRecord {
  clientId: string;
  revoked: boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export const CLIENT_TTL_SEC = 180 * 86_400;
export const REQUEST_TTL_SEC = 600;
export const CODE_TTL_SEC = 120;

export class OAuthStore {
  constructor(
    readonly kv: KvStore,
    private readonly ttl: { accessSec: number; refreshSec: number },
  ) {}

  // ------------------------------------------------------------ clients

  async putClient(c: ClientRecord, ttlSec = CLIENT_TTL_SEC): Promise<void> {
    await this.kv.kvSet(`${P}client:${await sha256Hex(c.clientId)}`, c, { ttlSec });
  }

  async getClient(clientId: string): Promise<ClientRecord | null> {
    return this.kv.kvGet<ClientRecord>(`${P}client:${await sha256Hex(clientId)}`);
  }

  // ------------------------------------------------------------ authorization requests

  async putRequest(r: AuthRequest): Promise<string> {
    const id = randomToken(24);
    await this.kv.kvSet(`${P}request:${await sha256Hex(id)}`, r, { ttlSec: REQUEST_TTL_SEC });
    return id;
  }

  async getRequest(id: string): Promise<AuthRequest | null> {
    return this.kv.kvGet<AuthRequest>(`${P}request:${await sha256Hex(id)}`);
  }

  async deleteRequest(id: string): Promise<void> {
    await this.kv.kvDelete(`${P}request:${await sha256Hex(id)}`);
  }

  // ------------------------------------------------------------ codes

  async issueCode(c: CodeRecord): Promise<string> {
    const code = randomToken(32);
    await this.kv.kvSet(`${P}code:${await sha256Hex(code)}`, c, { ttlSec: CODE_TTL_SEC });
    return code;
  }

  /** Read and delete in one step: a code works once. */
  async takeCode(code: string): Promise<CodeRecord | null> {
    const key = `${P}code:${await sha256Hex(code)}`;
    const rec = await this.kv.kvGet<CodeRecord>(key);
    if (rec) await this.kv.kvDelete(key);
    return rec;
  }

  // ------------------------------------------------------------ tokens

  async issueTokens(clientId: string, scope: string, resource: string, familyId?: string): Promise<IssuedTokens> {
    const family = familyId ?? randomToken(16);
    await this.kv.kvSet(`${P}family:${family}`, { clientId, revoked: false } satisfies FamilyRecord, {
      ttlSec: this.ttl.refreshSec,
    });
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const now = Date.now();
    const base = { clientId, scope, resource, familyId: family };
    await this.kv.kvSet(
      `${P}access:${await sha256Hex(accessToken)}`,
      { ...base, expiresAt: now + this.ttl.accessSec * 1000 } satisfies TokenRecord,
      { ttlSec: this.ttl.accessSec },
    );
    await this.kv.kvSet(
      `${P}refresh:${await sha256Hex(refreshToken)}`,
      { ...base, expiresAt: now + this.ttl.refreshSec * 1000 } satisfies TokenRecord,
      { ttlSec: this.ttl.refreshSec },
    );
    return { accessToken, refreshToken, expiresIn: this.ttl.accessSec, scope };
  }

  private async familyLive(familyId: string): Promise<boolean> {
    const f = await this.kv.kvGet<FamilyRecord>(`${P}family:${familyId}`);
    return Boolean(f && !f.revoked);
  }

  /** The access token's record when it exists, has not expired and its family was not revoked. */
  async verifyAccess(token: string): Promise<TokenRecord | null> {
    const rec = await this.kv.kvGet<TokenRecord>(`${P}access:${await sha256Hex(token)}`);
    if (!rec || rec.expiresAt <= Date.now()) return null;
    return (await this.familyLive(rec.familyId)) ? rec : null;
  }

  /**
   * Rotate a refresh token: the old one stops working and a new pair is
   * issued in the same family. A token that was already rotated out revokes
   * the family, so a stolen refresh token cannot be used alongside the real one.
   */
  async rotateRefresh(
    token: string,
    clientId: string,
  ): Promise<{ ok: true; record: TokenRecord } | { ok: false; reason: 'invalid' | 'reused' | 'client' }> {
    const hash = await sha256Hex(token);
    const key = `${P}refresh:${hash}`;
    const rec = await this.kv.kvGet<TokenRecord>(key);
    if (!rec) {
      const spent = await this.kv.kvGet<{ familyId: string }>(`${P}spent:${hash}`);
      if (spent) {
        await this.revokeFamily(spent.familyId);
        return { ok: false, reason: 'reused' };
      }
      return { ok: false, reason: 'invalid' };
    }
    if (rec.clientId !== clientId) return { ok: false, reason: 'client' };
    if (rec.expiresAt <= Date.now() || !(await this.familyLive(rec.familyId))) return { ok: false, reason: 'invalid' };
    await this.kv.kvDelete(key);
    await this.kv.kvSet(`${P}spent:${hash}`, { familyId: rec.familyId }, { ttlSec: this.ttl.refreshSec });
    return { ok: true, record: rec };
  }

  async revokeFamily(familyId: string): Promise<void> {
    const f = await this.kv.kvGet<FamilyRecord>(`${P}family:${familyId}`);
    if (f) await this.kv.kvSet(`${P}family:${familyId}`, { ...f, revoked: true }, { ttlSec: this.ttl.refreshSec });
  }

  /** RFC 7009 revocation of the caller's own access or refresh token; revokes the whole family either way. */
  async revoke(token: string, clientId: string): Promise<void> {
    const hash = await sha256Hex(token);
    const rec =
      (await this.kv.kvGet<TokenRecord>(`${P}access:${hash}`)) ?? (await this.kv.kvGet<TokenRecord>(`${P}refresh:${hash}`));
    if (rec && rec.clientId === clientId) await this.revokeFamily(rec.familyId);
  }

  // ------------------------------------------------------------ login attempt counters

  async failures(key: string): Promise<number> {
    return (await this.kv.kvGet<number>(`${P}fail:${key}`)) ?? 0;
  }

  async addFailure(key: string, windowSec: number): Promise<void> {
    await this.kv.kvSet(`${P}fail:${key}`, (await this.failures(key)) + 1, { ttlSec: windowSec });
  }
}
