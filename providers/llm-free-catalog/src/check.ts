/**
 * The logic behind `npm run check:llm`: send one tiny real request to every
 * enabled LLM rung and report what answered. Runtime-neutral (it only uses
 * the rungs and the ctx), so it is tested on recorded responses; the node
 * entry point is scripts/check-llm.ts.
 *
 * Rungs of the same service run one after another (keyless hosts such as OVH
 * allow about 2 requests per minute per model per IP), services run in
 * parallel up to `concurrency`, and every rung has its own timeout.
 */
import {
  type ChatRequest,
  type Ctx,
  isRungEnabled,
  keylessAllowed,
  type LlmRung,
  redact,
  type Tier,
  Vid2ContextError,
} from '@vid2context/core';

/** A short instruction with one fixed answer, cheap on every model. */
export const CHECK_REQUEST: ChatRequest = {
  messages: [{ role: 'user', content: 'What is 17 plus 25? Reply with the number only.' }],
  // Room for reasoning models that think before answering.
  maxTokens: 400,
};
export const CHECK_EXPECTED = '42';

export interface CheckOptions {
  only?: string[];
  skip?: string[];
  includePaid?: boolean;
  timeoutMs?: number;
  concurrency?: number;
}

export interface CheckRow {
  id: string;
  tier: Tier;
  service: string;
  model: string;
  /** The model that actually answered, when it differs from the rung's (OpenRouter free-auto). */
  answeredBy?: string;
  ms: number;
  outcome: 'ok' | 'error';
  /** Error code with the HTTP status when there was one, e.g. 'auth-401', 'timeout'. */
  code?: string;
  /** Short, redacted reason for a failure. */
  reason?: string;
  correct: boolean;
}

export interface CheckSelection {
  run: LlmRung[];
  /** Enabled rungs left out, with why (paid without --include-paid). */
  skipped: { id: string; why: string }[];
}

function matches(rung: LlmRung, keys: string[]): boolean {
  return keys.some((k) => k === rung.id || k === rung.service || k === rung.provider || rung.id.startsWith(`${k}/`));
}

/** The rungs `check:llm` will call: enabled ones, filtered by --only and --skip, paid only with --include-paid. */
export function selectRungs(rungs: LlmRung[], env: Record<string, string | undefined>, opts: CheckOptions = {}): CheckSelection {
  const run: LlmRung[] = [];
  const skipped: CheckSelection['skipped'] = [];
  for (const r of rungs) {
    if (!isRungEnabled(r, env)) continue;
    if (r.tier === 'keyless' && !keylessAllowed(env)) continue;
    if (opts.only?.length && !matches(r, opts.only)) continue;
    if (opts.skip?.length && matches(r, opts.skip)) continue;
    if (r.tier === 'paid' && !opts.includePaid) {
      skipped.push({ id: r.id, why: 'paid (pass --include-paid)' });
      continue;
    }
    run.push(r);
  }
  return { run, skipped };
}

function codeOf(err: unknown): string {
  if (err instanceof Vid2ContextError) return err.status ? `${err.code}-${err.status}` : err.code;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return 'error';
}

function reasonOf(err: unknown, env: Record<string, string | undefined>): string {
  const msg = err instanceof Error ? err.message : String(err);
  const oneLine = redact(msg, env).replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/** True when the answer is the expected number and nothing that contradicts it. */
export function isCorrect(text: string): boolean {
  const numbers = text.match(/-?\d+(\.\d+)?/g) ?? [];
  return numbers.length > 0 && numbers.every((n) => n === CHECK_EXPECTED);
}

async function checkOne(rung: LlmRung, ctx: Ctx, timeoutMs: number): Promise<CheckRow> {
  const base = { id: rung.id, tier: rung.tier, service: rung.service, model: rung.model };
  const started = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const inner: Ctx = { ...ctx, signal };
  try {
    const result = await Promise.race([
      rung.chat(CHECK_REQUEST, inner),
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Timed out', 'TimeoutError')), {
          once: true,
        });
      }),
    ]);
    return {
      ...base,
      ...(result.model && result.model !== rung.model ? { answeredBy: result.model } : {}),
      ms: Date.now() - started,
      outcome: 'ok',
      correct: isCorrect(result.text),
    };
  } catch (err) {
    return {
      ...base,
      ms: Date.now() - started,
      outcome: 'error',
      code: codeOf(err),
      reason: reasonOf(err, ctx.env),
      correct: false,
    };
  }
}

/** Call every rung once. Rows come back in the order of `rungs`. */
export async function runChecks(rungs: LlmRung[], ctx: Ctx, opts: CheckOptions = {}): Promise<CheckRow[]> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const groups = new Map<string, LlmRung[]>();
  for (const r of rungs) groups.set(r.service, [...(groups.get(r.service) ?? []), r]);
  const queue = [...groups.values()];
  const results = new Map<string, CheckRow>();
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const rung of group) {
        if (ctx.signal?.aborted) return;
        const row = await checkOne(rung, ctx, timeoutMs);
        results.set(rung.id, row);
        ctx.log.info('check:llm', { rung: row.id, outcome: row.outcome, code: row.code, ms: row.ms });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return rungs.map((r) => results.get(r.id)).filter((r): r is CheckRow => Boolean(r));
}

/** Plain-text table for stdout. */
export function formatTable(rows: CheckRow[], skipped: CheckSelection['skipped'] = []): string {
  // The outcome column is last because failure reasons can be long.
  const header = ['rung', 'tier', 'service', 'ms', 'correct', 'outcome'];
  const body = rows.map((r) => [
    r.answeredBy ? `${r.id} (${r.answeredBy})` : r.id,
    r.tier,
    r.service,
    String(r.ms),
    r.outcome === 'ok' ? (r.correct ? 'yes' : 'no') : '-',
    r.outcome === 'ok' ? 'ok' : `${r.code}: ${r.reason}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const okCount = rows.filter((r) => r.outcome === 'ok').length;
  const correctCount = rows.filter((r) => r.correct).length;
  const out = [line(header), ...body.map(line), ''];
  out.push(`${okCount} of ${rows.length} rungs answered, ${correctCount} correctly.`);
  for (const s of skipped) out.push(`skipped ${s.id}: ${s.why}`);
  return out.join('\n');
}

/** 0 when at least one rung answered, else 1. */
export function exitCodeFor(rows: CheckRow[]): number {
  return rows.some((r) => r.outcome === 'ok') ? 0 : 1;
}
