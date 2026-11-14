/**
 * Accounts, stored in a KvStore. An account holds only what GitHub sign-in
 * needs to show who is signed in: the GitHub numeric id, the login and the
 * avatar URL. Never an email address, a name or a GitHub token.
 *
 * Keys:
 *   accounts:account:<accountId>   Account
 *   accounts:github:<githubId>     accountId
 */
import type { KvStore } from '@vid2context/core';
import { randomToken } from './crypto.ts';

export interface Account {
  /** Opaque id, `acc_` plus random base64url. Logs carry this, never the login. */
  id: string;
  githubId: number;
  login: string;
  avatarUrl?: string;
  plan: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
}

/** The only fields taken from GitHub's /user response. */
export interface GithubIdentity {
  id: number;
  login: string;
  avatarUrl?: string;
}

const accountKey = (id: string) => `accounts:account:${id}`;
const githubKey = (githubId: number) => `accounts:github:${githubId}`;

export async function getAccount(kv: KvStore, id: string): Promise<Account | null> {
  return kv.kvGet<Account>(accountKey(id));
}

/** Find or create the account for a GitHub identity, refreshing its login and avatar. */
export async function upsertGithubAccount(
  kv: KvStore,
  identity: GithubIdentity,
  opts: { plan: string; now?: Date },
): Promise<Account> {
  const now = (opts.now ?? new Date()).toISOString();
  const existingId = await kv.kvGet<string>(githubKey(identity.id));
  const existing = existingId ? await getAccount(kv, existingId) : null;
  const account: Account = existing
    ? { ...existing, login: identity.login, avatarUrl: identity.avatarUrl, updatedAt: now }
    : {
        id: `acc_${randomToken(16)}`,
        githubId: identity.id,
        login: identity.login,
        avatarUrl: identity.avatarUrl,
        plan: opts.plan,
        createdAt: now,
        updatedAt: now,
      };
  if (account.avatarUrl === undefined) delete account.avatarUrl;
  await kv.kvSet(accountKey(account.id), account);
  if (!existing) await kv.kvSet(githubKey(identity.id), account.id);
  return account;
}

/** Move an account to another plan (operators only; there is no self-service upgrade). */
export async function setAccountPlan(kv: KvStore, id: string, plan: string): Promise<Account | null> {
  const account = await getAccount(kv, id);
  if (!account) return null;
  const next = { ...account, plan, updatedAt: new Date().toISOString() };
  await kv.kvSet(accountKey(id), next);
  return next;
}
