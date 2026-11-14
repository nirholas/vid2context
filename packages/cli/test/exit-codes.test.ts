import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ErrorCode, Vid2ContextError } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { EXIT_BY_CODE, EXIT_FAILURE, EXIT_USAGE, exitCodeFor, exitCodeTable, UsageError } from '../src/exit-codes.ts';
import { ROOT } from './helpers.ts';

// Every ErrorCode, read from the union in core so a new code shows up here.
const errorsTs = readFileSync(join(ROOT, 'packages/core/src/errors.ts'), 'utf8');
const union = /export type ErrorCode =([\s\S]*?);/.exec(errorsTs)?.[1] ?? '';
const CODES = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as ErrorCode);

describe('exit codes', () => {
  it('maps every ErrorCode to its own number, distinct from 0, 1, 2 and 130', () => {
    expect(CODES.length).toBeGreaterThan(10);
    expect(Object.keys(EXIT_BY_CODE).sort()).toEqual([...CODES].sort());
    const numbers = exitCodeTable().map((r) => r.code);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const code of CODES) expect(exitCodeFor(new Vid2ContextError(code, 'x'))).toBe(EXIT_BY_CODE[code]);
    expect(exitCodeFor(new UsageError('x'))).toBe(EXIT_USAGE);
    expect(exitCodeFor(new Error('x'))).toBe(EXIT_FAILURE);
  });

  it('is documented in docs/cli.md', () => {
    const doc = readFileSync(join(ROOT, 'docs/cli.md'), 'utf8');
    for (const row of exitCodeTable()) expect(doc).toContain(`| ${row.code} | \`${row.name}\` |`);
  });
});
