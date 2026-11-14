/**
 * Usage ledger: per rung requests, failures, tokens, audio seconds and the
 * estimated cost of paid rungs, plus the daily paid budget the chain checks.
 *
 * Prices are USD. Token prices are per million tokens ("in,out"); audio prices
 * are per minute of audio (one number). Override or add any price with
 * VID2CONTEXT_PRICE_<RUNG_ID_NORMALIZED>, where the rung id is upper-cased,
 * the pooled-key suffix (#2) is dropped and every run of other characters
 * becomes "_": stt/openai/whisper-1 -> VID2CONTEXT_PRICE_STT_OPENAI_WHISPER_1.
 * A rung with no known price is counted but not estimated.
 */
import type { Env, Tier } from '../types.ts';

export type Price = { kind: 'tokens'; inPerM: number; outPerM: number } | { kind: 'audio'; perMinute: number };

/**
 * Defaults, only for prices read on the vendor's pricing page.
 * Verified 2026-11-14 on https://developers.openai.com/api/docs/pricing
 * (standard tier): gpt-5.4-nano $0.20 input and $1.25 output per 1M tokens;
 * Whisper transcription $0.006 per minute.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  'llm/openai/gpt-5.4-nano': { kind: 'tokens', inPerM: 0.2, outPerM: 1.25 },
  'stt/openai/whisper-1': { kind: 'audio', perMinute: 0.006 },
};

/** Drop the pooled-key suffix: 'llm/groq#2/x' -> 'llm/groq/x'. */
function basePriceId(rungId: string): string {
  return rungId.replace(/#\d+(?=\/|$)/, '');
}

export function priceEnvName(rungId: string): string {
  const norm = basePriceId(rungId)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `VID2CONTEXT_PRICE_${norm}`;
}

function parsePrice(raw: string, rungId: string): Price | undefined {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  if (parts.length === 2) return { kind: 'tokens', inPerM: parts[0] as number, outPerM: parts[1] as number };
  if (parts.length === 1 && !rungId.startsWith('llm/') && !rungId.startsWith('embed/')) {
    return { kind: 'audio', perMinute: parts[0] as number };
  }
  return undefined;
}

/** The price for a rung: env override first, then a verified default, else undefined. */
export function priceFor(rungId: string, env: Env): Price | undefined {
  const raw = env[priceEnvName(rungId)];
  if (raw !== undefined && raw.trim() !== '') return parsePrice(raw, rungId);
  return DEFAULT_PRICES[basePriceId(rungId)];
}

export interface UsageRecord {
  rung: string;
  tier: Tier;
  ok: boolean;
  tokensIn?: number;
  tokensOut?: number;
  audioSec?: number;
}

export interface RungUsage {
  rung: string;
  tier: Tier;
  requests: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
  audioSeconds: number;
  /** Estimated USD; present only for paid rungs with a known price. */
  usd?: number;
}

export interface LedgerSnapshot {
  /** UTC day (YYYY-MM-DD) the daily figures belong to. */
  day: string;
  paidUsdToday: number;
  /** VID2CONTEXT_MAX_PAID_USD_PER_DAY when set. */
  maxPaidUsdPerDay?: number;
  overBudget: boolean;
  totals: { requests: number; failures: number; tokensIn: number; tokensOut: number; audioSeconds: number; usd: number };
  rungs: RungUsage[];
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function costOf(
  price: Price | undefined,
  u: Pick<UsageRecord, 'tokensIn' | 'tokensOut' | 'audioSec'>,
): number | undefined {
  if (!price) return undefined;
  if (price.kind === 'tokens') {
    if (u.tokensIn === undefined && u.tokensOut === undefined) return undefined;
    return ((u.tokensIn ?? 0) * price.inPerM + (u.tokensOut ?? 0) * price.outPerM) / 1e6;
  }
  if (u.audioSec === undefined) return undefined;
  return (u.audioSec / 60) * price.perMinute;
}

/** Per process. Daily paid spend resets at UTC midnight; per-rung totals accumulate for the process lifetime. */
export class UsageLedger {
  private readonly env: Env;
  private readonly now: () => number;
  private readonly rows = new Map<string, RungUsage>();
  private day: string;
  private spentToday = 0;

  constructor(opts: { env: Env; now?: () => number }) {
    this.env = opts.env;
    this.now = opts.now ?? Date.now;
    this.day = utcDay(this.now());
  }

  private roll(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.spentToday = 0;
    }
  }

  /** Record one rung attempt. Returns the estimated USD when the rung is paid and priced. */
  record(u: UsageRecord): number | undefined {
    this.roll();
    let row = this.rows.get(u.rung);
    if (!row) {
      row = { rung: u.rung, tier: u.tier, requests: 0, failures: 0, tokensIn: 0, tokensOut: 0, audioSeconds: 0 };
      this.rows.set(u.rung, row);
    }
    row.requests++;
    if (!u.ok) row.failures++;
    row.tokensIn += u.tokensIn ?? 0;
    row.tokensOut += u.tokensOut ?? 0;
    row.audioSeconds += u.audioSec ?? 0;
    if (u.tier !== 'paid') return undefined;
    const usd = costOf(priceFor(u.rung, this.env), u);
    if (usd === undefined) return undefined;
    row.usd = (row.usd ?? 0) + usd;
    this.spentToday += usd;
    return usd;
  }

  /** VID2CONTEXT_MAX_PAID_USD_PER_DAY, or undefined when unset or not a number. */
  maxPaidUsdPerDay(): number | undefined {
    const raw = this.env.VID2CONTEXT_MAX_PAID_USD_PER_DAY;
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  paidUsdToday(): number {
    this.roll();
    return this.spentToday;
  }

  /** True when a daily limit is set and today's estimated paid spend has reached it. */
  overBudget(): boolean {
    const max = this.maxPaidUsdPerDay();
    return max !== undefined && this.paidUsdToday() >= max;
  }

  snapshot(): LedgerSnapshot {
    this.roll();
    const rungs = [...this.rows.values()].map((r) => ({ ...r }));
    const totals = { requests: 0, failures: 0, tokensIn: 0, tokensOut: 0, audioSeconds: 0, usd: 0 };
    for (const r of rungs) {
      totals.requests += r.requests;
      totals.failures += r.failures;
      totals.tokensIn += r.tokensIn;
      totals.tokensOut += r.tokensOut;
      totals.audioSeconds += r.audioSeconds;
      totals.usd += r.usd ?? 0;
    }
    const max = this.maxPaidUsdPerDay();
    const snap: LedgerSnapshot = { day: this.day, paidUsdToday: this.spentToday, overBudget: this.overBudget(), totals, rungs };
    if (max !== undefined) snap.maxPaidUsdPerDay = max;
    return snap;
  }
}
