/**
 * Static checks on a single rung, shared by the rung suites and the registry
 * invariants. Each returns human-readable problems; an empty list means the
 * rung follows docs/contracts/providers.md.
 */
import { isRungEnabled, type Rung, type Tier } from '@vid2context/core';
import { isPromiseLike, withoutNetwork } from './fixtures.ts';

export type RungKind = 'stt' | 'llm' | 'embed' | 'video' | 'visual';

export const TIERS: Tier[] = ['local', 'free', 'keyless', 'paid'];
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Service names: lowercase slug, optionally '#n' for the nth pooled key. */
const SERVICE = /^[a-z0-9][a-z0-9._-]*(#[2-9]|#[1-9][0-9]+)?$/;

/** The id a rung should have: `<kind>/<service>/<model>`, or `<kind>/<service>` when no model is configured. */
export function expectedRungId(kind: RungKind, rung: Pick<Rung, 'service' | 'model'>): string {
  return rung.model ? `${kind}/${rung.service}/${rung.model}` : `${kind}/${rung.service}`;
}

/** Value used for every required env var when checking enablement. Syntactically a string, never a real credential. */
export const CONFORMANCE_VALUE = 'conformance-check-value';

export function rungProblems(rung: Rung, kind: RungKind): string[] {
  const p: string[] = [];
  if (rung.id !== expectedRungId(kind, rung)) {
    p.push(`id "${rung.id}" should be "${expectedRungId(kind, rung)}" (<kind>/<service>/<model>)`);
  }
  if (!rung.provider) p.push('provider is empty');
  if (!SERVICE.test(rung.service ?? '')) p.push(`service "${rung.service}" is not a lowercase slug (pooled keys add #n, n >= 2)`);
  if (!TIERS.includes(rung.tier)) p.push(`tier "${rung.tier}" is not one of ${TIERS.join(', ')}`);
  if (!Array.isArray(rung.requires)) p.push('requires is not an array');
  else {
    for (const r of rung.requires) if (!ENV_NAME.test(r)) p.push(`requires entry "${r}" is not an UPPER_SNAKE env var name`);
    if (rung.tier === 'keyless' && rung.requires.length > 0)
      p.push(`keyless rung requires ${rung.requires.join(', ')}; keyless rungs need no env`);
    if ((rung.tier === 'free' || rung.tier === 'paid') && rung.requires.length === 0) {
      p.push(`${rung.tier} rung has empty requires; free and paid rungs need at least one key`);
    }
  }
  if (!Number.isFinite(rung.priority)) p.push(`priority ${String(rung.priority)} is not a finite number`);
  if (!Number.isInteger(rung.quality) || rung.quality < 1 || rung.quality > 5)
    p.push(`quality ${String(rung.quality)} is not an integer 1..5`);
  if (!Array.isArray(rung.capabilities) || rung.capabilities.some((c) => typeof c !== 'string' || !c)) {
    p.push('capabilities is not an array of non-empty strings');
  }

  // isEnabled must decide from env alone: synchronous, no network, no mutation (frozen env).
  const empty = Object.freeze({}) as Record<string, string | undefined>;
  const full = Object.freeze(Object.fromEntries((rung.requires ?? []).map((k) => [k, CONFORMANCE_VALUE])));
  for (const [label, env] of [
    ['empty env', empty],
    ['env with every required var', full],
  ] as const) {
    try {
      const { value, touched } = withoutNetwork(() => isRungEnabled(rung, env));
      if (isPromiseLike(value)) p.push(`isEnabled returned a Promise with ${label}; it must be synchronous`);
      else if (typeof value !== 'boolean') p.push(`isEnabled returned ${typeof value} with ${label}, not a boolean`);
      if (touched.length > 0) p.push(`isEnabled reached the network with ${label}: ${touched[0]}`);
      if (label === 'empty env' && value === true && (rung.tier === 'free' || rung.tier === 'paid')) {
        p.push(`${rung.tier} rung is enabled with an empty env; it must need its key`);
      }
    } catch (err) {
      p.push(`isEnabled threw with ${label} (a frozen env object): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const extra = rung as Rung & { maxBytes?: unknown; contextTokens?: unknown; dimensions?: unknown };
  if (kind === 'stt' && extra.maxBytes !== undefined && !(Number(extra.maxBytes) > 0)) p.push('maxBytes is set but not positive');
  if (kind === 'llm' && extra.contextTokens !== undefined && !(Number(extra.contextTokens) > 0)) {
    p.push('contextTokens is set but not positive');
  }
  if (kind === 'embed' && !(Number.isInteger(extra.dimensions) && Number(extra.dimensions) > 0)) {
    p.push('dimensions is not a positive integer');
  }
  return p;
}

/** The error code errorFromResponse maps an HTTP status to (docs/contracts/providers.md, rule 3). */
export function expectedCodeForStatus(status: number): string {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 404 || status === 410) return 'not-found';
  if (status === 413) return 'too-large';
  return 'upstream';
}
