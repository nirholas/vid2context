/**
 * Plans: daily limits per account. Configured with VID2CONTEXT_PLANS (JSON);
 * the defaults below apply to any plan name the JSON leaves out. There are no
 * paid plans: an operator can define more plans and assign them with
 * setAccountPlan, but nothing here takes payments.
 */
import type { Env } from '@vid2context/core';

export interface Plan {
  /** API requests per UTC day (account management routes under /me are not counted). */
  requestsPerDay: number;
  /** Minutes of audio sent to speech-to-text or video-model rungs per UTC day. Cached results cost nothing. */
  sttMinutesPerDay: number;
  /** Successful LLM calls per UTC day. */
  llmCallsPerDay: number;
  /** Most videos one collection may hold. */
  maxCollectionSize: number;
}

/** Plan for signed-in accounts unless VID2CONTEXT_DEFAULT_PLAN names another. */
export const FREE_PLAN = 'free';
/** Plan for anonymous callers, counted per IP (VID2CONTEXT_ANONYMOUS=1). */
export const ANONYMOUS_PLAN = 'anonymous';

export const DEFAULT_PLANS: Readonly<Record<string, Plan>> = Object.freeze({
  [FREE_PLAN]: { requestsPerDay: 500, sttMinutesPerDay: 60, llmCallsPerDay: 100, maxCollectionSize: 200 },
  [ANONYMOUS_PLAN]: { requestsPerDay: 50, sttMinutesPerDay: 10, llmCallsPerDay: 10, maxCollectionSize: 25 },
});

const FIELDS: (keyof Plan)[] = ['requestsPerDay', 'sttMinutesPerDay', 'llmCallsPerDay', 'maxCollectionSize'];

/**
 * Parse VID2CONTEXT_PLANS. Each named plan may set any subset of the fields;
 * missing fields come from the default plan of the same name, or from `free`.
 * Throws a plain Error on invalid config: that is an operator mistake, so the
 * server answers 500 and logs the message rather than blaming the caller.
 */
export function parsePlans(json: string | undefined): Record<string, Plan> {
  const plans: Record<string, Plan> = { ...DEFAULT_PLANS };
  if (!json?.trim()) return plans;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`VID2CONTEXT_PLANS is not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('VID2CONTEXT_PLANS must be a JSON object mapping plan names to limits.');
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
      throw new Error(`VID2CONTEXT_PLANS: invalid plan name "${name.slice(0, 40)}" (use a-z, 0-9, - and _).`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`VID2CONTEXT_PLANS: plan "${name}" must be an object.`);
    }
    const base = plans[name] ?? DEFAULT_PLANS[FREE_PLAN];
    const plan = { ...base } as Plan;
    for (const [field, n] of Object.entries(value as Record<string, unknown>)) {
      if (!FIELDS.includes(field as keyof Plan)) {
        throw new Error(`VID2CONTEXT_PLANS: plan "${name}" has unknown field "${field}". Known: ${FIELDS.join(', ')}.`);
      }
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        throw new Error(`VID2CONTEXT_PLANS: ${name}.${field} must be a number of 0 or more.`);
      }
      plan[field as keyof Plan] = n;
    }
    plans[name] = plan;
  }
  return plans;
}

export function planFor(name: string | undefined, plans: Record<string, Plan>, env: Env): { name: string; plan: Plan } {
  const fallback = env.VID2CONTEXT_DEFAULT_PLAN || FREE_PLAN;
  const pick = name && plans[name] ? name : plans[fallback] ? fallback : FREE_PLAN;
  return { name: pick, plan: plans[pick] ?? (DEFAULT_PLANS[FREE_PLAN] as Plan) };
}
