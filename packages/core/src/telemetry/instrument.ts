/**
 * The few helpers the chain and the pipeline call. Each is only reached when
 * `ctx.telemetry` is set, so an uninstrumented run allocates nothing extra.
 * Attributes carry ids, tiers, outcomes and numbers only: never transcript
 * text, prompts, URLs or env values.
 */
import type { Rung } from '../provider.ts';
import type { Attempt, VideoRef } from '../types.ts';
import { nowMs } from './ids.ts';
import type { Span, Telemetry } from './types.ts';

export interface UsageNumbers {
  tokensIn?: number;
  tokensOut?: number;
  audioSec?: number;
}

function finite(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Usage carried by a rung result: LLM `usage` token counts, and for speech to
 * text the audio length (`durationSec` when the result has it, else the end
 * of the last segment, which can undercount trailing silence).
 */
export function usageOf(stage: Attempt['stage'], value: unknown): UsageNumbers {
  if (!value || typeof value !== 'object') return {};
  const out: UsageNumbers = {};
  const usage = (value as { usage?: { inputTokens?: unknown; outputTokens?: unknown } }).usage;
  if (usage && typeof usage === 'object') {
    out.tokensIn = finite(usage.inputTokens);
    out.tokensOut = finite(usage.outputTokens);
  }
  if (stage === 'stt') {
    const v = value as { durationSec?: unknown; segments?: { endSec?: unknown }[] };
    let sec = finite(v.durationSec);
    if (sec === undefined && Array.isArray(v.segments)) {
      sec = v.segments.reduce((m, s) => Math.max(m, finite(s?.endSec) ?? 0), 0);
    }
    if (sec !== undefined && sec > 0) out.audioSec = sec;
  }
  return out;
}

function recordUsage(tel: Telemetry, rung: Rung, ok: boolean, u: UsageNumbers, span?: Span): void {
  const base = { rung: rung.id, service: rung.service, tier: rung.tier };
  if (u.tokensIn !== undefined) tel.counter('vid2context.llm.tokens', u.tokensIn, { ...base, direction: 'in' });
  if (u.tokensOut !== undefined) tel.counter('vid2context.llm.tokens', u.tokensOut, { ...base, direction: 'out' });
  if (u.audioSec !== undefined) tel.counter('vid2context.stt.audio_seconds', u.audioSec, base);
  const usd = tel.ledger?.record({ rung: rung.id, tier: rung.tier, ok, ...u });
  if (usd !== undefined) tel.counter('vid2context.paid.usd', usd, base);
  span?.setAttributes({
    'vid2context.usage.tokens_in': u.tokensIn,
    'vid2context.usage.tokens_out': u.tokensOut,
    'vid2context.usage.audio_seconds': u.audioSec,
    'vid2context.usage.usd': usd,
  });
}

/**
 * Run one rung attempt inside a `vid2context.rung` span and record the
 * attempt counter, the duration histogram and usage. Rethrows the rung's
 * error unchanged so the chain's own handling is untouched.
 */
export async function tracedRungCall<R extends Rung, T>(
  tel: Telemetry,
  stage: Attempt['stage'],
  rung: R,
  call: (rung: R) => Promise<T>,
  reasonOf: (err: unknown) => string,
): Promise<T> {
  const attrs = { rung: rung.id, service: rung.service, tier: rung.tier, stage };
  return tel.span(
    'vid2context.rung',
    {
      'vid2context.stage': stage,
      'vid2context.rung.id': rung.id,
      'vid2context.rung.service': rung.service,
      'vid2context.rung.tier': rung.tier,
      'vid2context.rung.model': rung.model,
    },
    async (span) => {
      const started = nowMs();
      try {
        const value = await call(rung);
        const ms = nowMs() - started;
        span.setAttributes({ 'vid2context.outcome': 'ok', 'vid2context.duration_ms': ms });
        tel.counter('vid2context.rung.attempts', 1, { ...attrs, outcome: 'ok' });
        tel.histogram('vid2context.rung.duration', ms, { ...attrs, outcome: 'ok' });
        recordUsage(tel, rung, true, usageOf(stage, value), span);
        return value;
      } catch (err) {
        const ms = nowMs() - started;
        const reason = reasonOf(err);
        span.setAttributes({ 'vid2context.outcome': 'error', 'vid2context.reason': reason, 'vid2context.duration_ms': ms });
        tel.counter('vid2context.rung.attempts', 1, { ...attrs, outcome: 'error', reason });
        tel.histogram('vid2context.rung.duration', ms, { ...attrs, outcome: 'error' });
        tel.ledger?.record({ rung: rung.id, tier: rung.tier, ok: false });
        throw err;
      }
    },
  );
}

/** Count a rung the chain skipped without calling it (cooldown, budget). */
export function recordRungSkip(tel: Telemetry, stage: Attempt['stage'], rung: Rung, reason: string): void {
  tel.counter('vid2context.rung.attempts', 1, {
    rung: rung.id,
    service: rung.service,
    tier: rung.tier,
    stage,
    outcome: 'skipped',
    reason,
  });
}

/** Hint attached to an attempt skipped by the daily paid budget. */
export function budgetDetail(max: number | undefined): string {
  return `Daily paid budget reached (VID2CONTEXT_MAX_PAID_USD_PER_DAY=${max ?? ''}). Raise the variable or wait for the next UTC day.`;
}

export type PipelineStage = 'resolve' | 'metadata' | 'captions' | 'audio' | 'stt' | 'video' | 'comments' | 'save';

/**
 * Run one pipeline stage inside a `vid2context.<stage>` span and record
 * `vid2context.stage.duration`. A null result (no captions, no audio) counts as outcome
 * `empty`. Only the ref id and platform are recorded about the input.
 */
export async function tracedStage<T>(
  tel: Telemetry,
  stage: PipelineStage,
  ref: VideoRef | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tel.span(
    `vid2context.${stage}`,
    { 'vid2context.stage': stage, 'vid2context.ref': ref?.id, 'vid2context.platform': ref?.platform },
    async (span) => {
      const started = nowMs();
      try {
        const value = await fn(span);
        const outcome = value === null ? 'empty' : 'ok';
        span.setAttributes({ 'vid2context.outcome': outcome });
        tel.histogram('vid2context.stage.duration', nowMs() - started, { stage, outcome });
        return value;
      } catch (err) {
        span.setAttributes({ 'vid2context.outcome': 'error' });
        tel.histogram('vid2context.stage.duration', nowMs() - started, { stage, outcome: 'error' });
        throw err;
      }
    },
  );
}
