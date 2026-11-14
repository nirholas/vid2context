/**
 * `npm run conformance`: checks every provider in the generated node, workers
 * and browser registries, then runs the storage suite on MemoryStorage and the
 * formatter suite on every formatter. Each provider gets one test per runtime
 * that lists its violations with the file they come from.
 */
import { formatters, MemoryStorage } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { describeFormatter, describeStorage } from '../src/index.ts';
import { checkInvariants, formatReport, RUNTIMES } from '../src/invariants.ts';

const report = await checkInvariants();
console.error(`\n${formatReport(report)}\n`);

describe('registry invariants', () => {
  const registryLevel = report.violations.filter((v) => !v.provider);
  it('the registries load, build and keep secrets out of health output', () => {
    expect(registryLevel.map((v) => `[${v.check}] (${v.runtime}) ${v.message}`)).toEqual([]);
  });
  // One test per provider (or per package that failed to import), listing its violations in every runtime.
  const ids = new Set<string>();
  for (const runtime of RUNTIMES) for (const id of report.providers[runtime]) ids.add(id);
  for (const v of report.violations) if (v.provider) ids.add(v.provider);
  for (const id of [...ids].sort()) {
    const runtimes = RUNTIMES.filter((r) => report.providers[r].includes(id));
    it(`${id}${runtimes.length ? ` (${runtimes.join(', ')})` : ''}`, () => {
      const mine = report.violations.filter((v) => v.provider === id);
      expect(mine.map((v) => `[${v.check}] (${v.runtime}) ${v.message}${v.file ? `  at ${v.file}` : ''}`)).toEqual([]);
    });
  }
});

describeStorage(() => new MemoryStorage(), { name: 'MemoryStorage' });
for (const f of Object.values(formatters)) describeFormatter(f);
