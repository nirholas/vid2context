/**
 * Option checking. Options can arrive from an HTTP body or an MCP call, so
 * every value is checked before it reaches a loop bound.
 */
import { Vid2ContextError } from '@vid2context/core';
import { DEFAULTS, type DedupeOptions } from './types.ts';

type Rule = { min: number; max: number; integer: boolean };

const RULES: Record<keyof DedupeOptions, Rule> = {
  shingleSize: { min: 1, max: 20, integer: true },
  numHashes: { min: 1, max: 1024, integer: true },
  bands: { min: 1, max: 1024, integer: true },
  seed: { min: 0, max: 0xffffffff, integer: true },
  blockShingles: { min: 1, max: 100_000, integer: true },
  maxGap: { min: 0, max: 1000, integer: true },
  minRunMatches: { min: 1, max: 1000, integer: true },
  maxOccurrences: { min: 1, max: 100_000, integer: true },
  reuploadOverlap: { min: 0, max: 1, integer: false },
  durationTolerance: { min: 0, max: 1, integer: false },
  durationSlackSec: { min: 0, max: 86_400, integer: false },
  clipOverlap: { min: 0, max: 1, integer: false },
  relatedMinWords: { min: 1, max: 100_000, integer: true },
  metadataMargin: { min: 0, max: 1, integer: false },
  titleSimilarity: { min: 0, max: 1, integer: false },
  minWords: { min: 1, max: 100_000, integer: true },
};

/** Defaults merged with checked overrides. Throws `bad-request` naming the bad option. */
export function resolveOptions(options: unknown = {}): Required<DedupeOptions> {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Vid2ContextError('bad-request', 'Dedupe options must be an object.', {
      hint: 'Pass for example { "clipOverlap": 0.5 }, or leave options out for the defaults.',
    });
  }
  const out: Required<DedupeOptions> = { ...DEFAULTS };
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    const rule = RULES[key as keyof DedupeOptions];
    if (!rule) {
      throw new Vid2ContextError('bad-request', `Unknown dedupe option "${key}".`, {
        hint: `Known options: ${Object.keys(RULES).join(', ')}.`,
      });
    }
    const ok =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= rule.min &&
      value <= rule.max &&
      (!rule.integer || Number.isInteger(value));
    if (!ok) {
      throw new Vid2ContextError(
        'bad-request',
        `Dedupe option "${key}" must be ${rule.integer ? 'an integer' : 'a number'} from ${rule.min} to ${rule.max}.`,
        { hint: `Leave "${key}" out to use the default (${DEFAULTS[key as keyof DedupeOptions]}).` },
      );
    }
    out[key as keyof DedupeOptions] = value;
  }
  if (out.bands > out.numHashes) {
    throw new Vid2ContextError('bad-request', '"bands" cannot exceed "numHashes".', {
      hint: `Use at most ${out.numHashes} bands, or raise numHashes.`,
    });
  }
  return out;
}
