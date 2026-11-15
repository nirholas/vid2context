import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../checks/lib.mjs';
import { alreadyPublished, corrections, harmfulCorrections, isHarmless } from '../release/npm-output.mjs';

// Recorded from npm 11.19.1, see tooling/test/fixtures/README.md.
const recorded = readFileSync(join(ROOT, 'tooling/test/fixtures/npm-publish-dry-run.stderr.txt'), 'utf8');
const cliManifest = { name: 'vid2context', bin: { vid2context: './dist/vid2context.mjs' } };

describe('npm publish output', () => {
  it('reads the corrections npm made to the manifest', () => {
    expect(corrections(recorded)).toEqual(['"bin[vid2context]" script name dist/vid2context.mjs was invalid and removed']);
  });

  it('accepts npm dropping the ./ prefix from a bin path, which keeps the bin', () => {
    expect(harmfulCorrections(recorded, cliManifest)).toEqual([]);
  });

  it('rejects a bin correction that changes the path or targets another bin', () => {
    const line = '"bin[vid2context]" script name dist/vid2context.mjs was invalid and removed';
    expect(isHarmless(line, { bin: { vid2context: './dist/other.mjs' } })).toBe(false);
    expect(isHarmless(line, { bin: { other: './dist/vid2context.mjs' } })).toBe(false);
    expect(isHarmless(line, { bin: './dist/vid2context.mjs' })).toBe(false);
    expect(harmfulCorrections(recorded, { bin: { vid2context: 'dist/vid2context.mjs' } })).toHaveLength(1);
  });

  it('treats any other correction as harmful', () => {
    const removed = 'npm warn publish errors corrected:\nnpm warn publish removed invalid "bin[vid2context]"\n';
    expect(harmfulCorrections(removed, cliManifest)).toEqual(['removed invalid "bin[vid2context]"']);
  });

  it('finds no corrections when npm reports none', () => {
    expect(corrections('npm notice total files: 5\n')).toEqual([]);
  });

  it('recognizes a version the registry already has', () => {
    expect(alreadyPublished(recorded)).toBe(true);
    expect(alreadyPublished('npm notice total files: 5\n')).toBe(false);
  });
});
