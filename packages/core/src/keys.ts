/**
 * Multi-key pools, the same convention as nirholas/sperax: `{PROVIDER}_API_KEY`
 * holds one key and `{PROVIDER}_FALLBACK_KEYS` holds extra comma-separated
 * keys. Each free-tier account has its own quota, so every key becomes its own
 * rung with its own cooldown. Keep the primary variable a single key.
 */
import type { Env } from './types.ts';

export interface PooledKey {
  key: string;
  /** The env var the key came from (for health output; never print the value). */
  envVar: string;
  /** 0 for the primary key, 1.. for pooled keys. */
  index: number;
}

/** GROQ_API_KEY -> GROQ_FALLBACK_KEYS, GITHUB_TOKEN -> GITHUB_FALLBACK_KEYS. */
export function defaultPoolVar(primaryVar: string): string {
  return `${primaryVar.replace(/_(API_KEY|API_TOKEN|TOKEN|KEY)$/, '')}_FALLBACK_KEYS`;
}

/** The primary key followed by pooled keys, trimmed and de-duplicated. Empty when none is set. */
export function keyPool(env: Env, primaryVar: string, poolVar: string = defaultPoolVar(primaryVar)): PooledKey[] {
  const seen = new Set<string>();
  const out: PooledKey[] = [];
  const add = (key: string, envVar: string) => {
    const k = key.trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ key: k, envVar, index: out.length });
  };
  add(env[primaryVar] ?? '', primaryVar);
  for (const k of (env[poolVar] ?? '').split(',')) add(k, poolVar);
  return out;
}

/** Service name for the nth key of a pool: 'groq', 'groq#2', 'groq#3'. */
export function pooledService(service: string, index: number): string {
  return index === 0 ? service : `${service}#${index + 1}`;
}
