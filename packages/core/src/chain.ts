/**
 * The free-first rung chain, shared by every rung kind (stt, llm, embed,
 * video, visual). Same design as the nirholas/three.ws and nirholas/sperax LLM
 * fallback chains: a rung is present only when its credential is set, keyless
 * lanes are a zero-config safety net, paid rungs are the last backstop, and a
 * rung that just failed with a quota or auth error cools down so the next
 * request does not waste an attempt on it.
 */
import { isInputError, Vid2ContextError } from './errors.ts';
import type { ChainOptions, Rung } from './provider.ts';
import { redact } from './security/redact.ts';
import { budgetDetail, recordRungSkip, tracedRungCall } from './telemetry/instrument.ts';
import type { Attempt, Ctx, Env, Policy, Tier } from './types.ts';

const TIER_ORDER: Record<Tier, number> = { local: 0, free: 1, keyless: 2, paid: 3 };

export function isRungEnabled(rung: Rung, env: Env): boolean {
  if (rung.isEnabled) return rung.isEnabled(env);
  return rung.requires.every((k) => Boolean(env[k]));
}

/** Keyless lanes send data to third-party hosts without an account; VID2CONTEXT_KEYLESS=0 turns them off. */
export function keylessAllowed(env: Env): boolean {
  return env.VID2CONTEXT_KEYLESS !== '0' && env.VID2CONTEXT_KEYLESS !== 'false';
}

function listFromEnv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesAny(rung: Rung, keys: string[]): boolean {
  return keys.some((k) => k === rung.id || k === rung.service || k === rung.provider);
}

/** Resolve chain options against env defaults (VID2CONTEXT_POLICY, VID2CONTEXT_ALLOW_PAID, VID2CONTEXT_SKIP). */
export function resolveChainOptions(opts: ChainOptions, env: Env): Required<Omit<ChainOptions, 'only'>> & { only?: string[] } {
  const envPolicy = env.VID2CONTEXT_POLICY as Policy | undefined;
  const policy: Policy = opts.policy ?? (envPolicy && ['free', 'local-only', 'quality'].includes(envPolicy) ? envPolicy : 'free');
  const allowPaidEnv = env.VID2CONTEXT_ALLOW_PAID;
  const allowPaid = opts.allowPaid ?? !(allowPaidEnv === '0' || allowPaidEnv === 'false');
  return {
    policy,
    allowPaid,
    only: opts.only,
    skip: [...(opts.skip ?? []), ...listFromEnv(env.VID2CONTEXT_SKIP)],
    needs: opts.needs ?? [],
    maxAttempts: opts.maxAttempts ?? 8,
    rungTimeoutMs: opts.rungTimeoutMs ?? rungTimeoutFromEnv(env),
  };
}

/** Default per-rung limit: 3 minutes, under the HTTP API's 5-minute request timeout so a fallback still gets its turn. */
export const DEFAULT_RUNG_TIMEOUT_MS = 180_000;

function rungTimeoutFromEnv(env: Env): number {
  const raw = env.VID2CONTEXT_RUNG_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_RUNG_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RUNG_TIMEOUT_MS;
}

/**
 * Settle with `work`, or reject with a `timeout` error after `ms` (0: no
 * limit). The abandoned call keeps running until the request's own signal
 * ends it; the chain no longer waits for it.
 */
function withRungTimeout<T>(rung: Rung, ms: number, work: () => Promise<T>): Promise<T> {
  if (ms <= 0 || rung.tier === 'local') return work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Vid2ContextError('timeout', `${rung.id} did not answer within ${Math.round(ms / 1000)} s.`, {
            hint: 'The service is slow or stuck; the next rung was tried. Raise VID2CONTEXT_RUNG_TIMEOUT_MS for very long inputs.',
          }),
        ),
      ms,
    );
  });
  return Promise.race([work(), expired]).finally(() => clearTimeout(timer));
}

/** Filter and order rungs for a request. Pure: no network, no cooldown state. */
export function rankRungs<R extends Rung>(rungs: R[], opts: ChainOptions, env: Env): R[] {
  const o = resolveChainOptions(opts, env);
  const filtered = rungs.filter((r) => {
    if (!isRungEnabled(r, env)) return false;
    if (r.tier === 'keyless' && !keylessAllowed(env)) return false;
    if (r.tier === 'paid' && !o.allowPaid) return false;
    if (o.policy === 'local-only' && r.tier !== 'local') return false;
    if (o.only && o.only.length > 0 && !matchesAny(r, o.only)) return false;
    if (o.skip.length > 0 && matchesAny(r, o.skip)) return false;
    if (o.needs.some((cap) => !r.capabilities.includes(cap))) return false;
    return true;
  });
  return filtered.sort((a, b) => {
    if (o.policy === 'quality') {
      return b.quality - a.quality || TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.priority - b.priority;
    }
    return TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.priority - b.priority || b.quality - a.quality;
  });
}

/**
 * Per-process cooldowns keyed by rung id plus a fingerprint of the credentials
 * the rung uses (its `requires` values). With the server's own keys the
 * fingerprint never changes, so this is a cooldown per rung. A key a caller
 * sent with one request gets its own entry: a rejected or exhausted user key
 * never cools the rung down for everyone else, and the reverse.
 */
const cooldowns = new Map<string, number>();
/** Expired entries are dropped once the map holds this many (user keys add entries). */
const COOLDOWN_PRUNE_AT = 2000;

export function clearCooldowns(): void {
  cooldowns.clear();
}

/** FNV-1a, 32 bit, as 8 hex digits. Only an in-memory map key: never stored, logged or sent. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function cooldownKey(rung: Rung, env: Env): string {
  if (rung.requires.length === 0) return rung.id;
  return `${rung.id}@${fingerprint(rung.requires.map((v) => env[v] ?? '').join('\u0000'))}`;
}

function setCooldown(key: string, until: number): void {
  if (cooldowns.size >= COOLDOWN_PRUNE_AT) {
    const now = Date.now();
    for (const [k, t] of cooldowns) if (t <= now) cooldowns.delete(k);
  }
  cooldowns.set(key, until);
}

/** Longest cooldown a Retry-After can ask for: 10 minutes. */
const MAX_RATE_LIMIT_COOLDOWN_SEC = 600;

function cooldownFor(err: unknown): number {
  if (!(err instanceof Vid2ContextError)) return 0;
  // Clamped: one provider answering "Retry-After: 86400" must not take its rung out for a day.
  if (err.code === 'rate-limited') return Math.min(Math.max(err.retryAfterSec ?? 60, 5), MAX_RATE_LIMIT_COOLDOWN_SEC) * 1000;
  if (err.code === 'auth') return 10 * 60 * 1000;
  if (err.code === 'not-found' && err.status !== undefined) return 30 * 60 * 1000;
  if (err.code === 'upstream' && (err.status ?? 0) >= 500) return 30 * 1000;
  // A rung that hung: skip it for a minute instead of making every request wait for it again.
  if (err.code === 'timeout' && err.status === undefined) return 60 * 1000;
  return 0;
}

function reasonFor(err: unknown): string {
  if (err instanceof Vid2ContextError) return err.status ? `${err.code}-${err.status}` : err.code;
  if (err instanceof Error && err.name === 'AbortError') return 'aborted';
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  return 'error';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ChainSuccess<R extends Rung, T> {
  value: T;
  rung: R;
  attempts: Attempt[];
}

/**
 * Try rungs in ranked order until one returns a value. Falls through on any
 * error except caller input errors. Throws `all-rungs-failed` (or
 * `no-provider` when nothing is enabled) with every attempt attached.
 */
export async function runChain<R extends Rung, T>(
  stage: Attempt['stage'],
  rungs: R[],
  call: (rung: R) => Promise<T>,
  opts: ChainOptions,
  ctx: Ctx,
): Promise<ChainSuccess<R, T>> {
  const ranked = rankRungs(rungs, opts, ctx.env);
  const { maxAttempts, rungTimeoutMs } = resolveChainOptions(opts, ctx.env);
  const attempts: Attempt[] = [];
  if (ranked.length === 0) {
    throw Object.assign(
      new Vid2ContextError('no-provider', `No ${stage} rung is enabled.`, {
        stage,
        hint: `Configure a ${stage} provider (see docs/providers.md). Keyless lanes need VID2CONTEXT_KEYLESS unset; local-only policy needs a local rung.`,
      }),
      { attempts },
    );
  }
  let tried = 0;
  for (const rung of ranked) {
    if (tried >= maxAttempts) break;
    const tel = ctx.telemetry;
    if (tel?.ledger && rung.tier === 'paid' && tel.ledger.overBudget()) {
      attempts.push({
        id: rung.id,
        stage,
        outcome: 'skipped',
        reason: 'budget',
        detail: budgetDetail(tel.ledger.maxPaidUsdPerDay()),
      });
      recordRungSkip(tel, stage, rung, 'budget');
      continue;
    }
    const cdKey = cooldownKey(rung, ctx.env);
    const until = cooldowns.get(cdKey);
    if (until && until > Date.now()) {
      attempts.push({ id: rung.id, stage, outcome: 'skipped', reason: 'cooldown' });
      if (tel) recordRungSkip(tel, stage, rung, 'cooldown');
      continue;
    }
    if (ctx.signal?.aborted) break;
    tried++;
    const started = Date.now();
    try {
      const value = await withRungTimeout(rung, rungTimeoutMs, () =>
        tel ? tracedRungCall(tel, stage, rung, call, reasonFor) : call(rung),
      );
      attempts.push({ id: rung.id, stage, outcome: 'ok', ms: Date.now() - started });
      return { value, rung, attempts };
    } catch (err) {
      if (isInputError(err)) throw err;
      const cd = cooldownFor(err);
      if (cd > 0) setCooldown(cdKey, Date.now() + cd);
      attempts.push({
        id: rung.id,
        stage,
        outcome: 'error',
        reason: reasonFor(err),
        detail: redact(errMessage(err), ctx.env).slice(0, 300),
        ms: Date.now() - started,
      });
      ctx.log.warn(`${stage} rung failed, trying the next one`, { rung: rung.id, reason: reasonFor(err) });
    }
  }
  throw Object.assign(
    new Vid2ContextError('all-rungs-failed', `Every ${stage} rung failed (${attempts.length} tried).`, {
      stage,
      hint: 'See `attempts` for each failure. Adding a free key (docs/providers.md) adds more rungs.',
    }),
    { attempts },
  );
}

/** Read the attempts attached to an error thrown by runChain or the pipeline. */
export function attemptsOf(err: unknown): Attempt[] {
  const a = (err as { attempts?: Attempt[] } | null)?.attempts;
  return Array.isArray(a) ? a : [];
}
