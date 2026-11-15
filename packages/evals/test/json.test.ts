import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { displayWidth, formatJson } from '../src/json.ts';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const repo = join(pkg, '..', '..');
const biome = join(repo, 'node_modules', '.bin', 'biome');

/** Committed JSON files that Biome already accepts: real results, datasets and recorded references. */
const committed = (): string[] =>
  ['results', 'datasets', join('datasets', 'refs')].flatMap((dir) =>
    readdirSync(join(pkg, dir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(pkg, dir, f)),
  );

function biomeFormat(text: string): string {
  return execFileSync(biome, ['format', '--stdin-file-path=packages/evals/results/check.json'], {
    cwd: repo,
    input: text,
    encoding: 'utf8',
  });
}

describe('formatJson', () => {
  it('reproduces every Biome-formatted JSON file in the package byte for byte', () => {
    const files = committed();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (biomeFormat(text) !== text) continue;
      expect(formatJson(JSON.parse(text)), file).toBe(text);
    }
  });

  it('writes the real 2026-11-15 STT result exactly as Biome formats it', () => {
    const text = readFileSync(join(pkg, 'results', '2026-11-15-stt.json'), 'utf8');
    const out = formatJson(JSON.parse(text));
    expect(out).toContain('"rungs": ["stt/ovh/whisper-large-v3-turbo", "stt/whisper-cpp/small"],');
    expect(biomeFormat(out)).toBe(out);
  });

  it('prints empty containers inline and breaks an array that does not fit the line width', () => {
    const long = Array.from({ length: 12 }, (_, i) => `stt/rung-number-${i}`);
    const out = formatJson({ items: [], env: {}, rungs: long });
    expect(out).toContain('"items": [],\n');
    expect(out).toContain('"env": {},\n');
    expect(out).toContain('"rungs": [\n    "stt/rung-number-0",\n');
    expect(biomeFormat(out)).toBe(out);
  });

  it('fills long number arrays line by line, as Biome does', () => {
    // Real chapter starts: the uniform baseline for the 2 h 8 min Lex Fridman podcast (26 chapters over 7705 s).
    const starts = Array.from({ length: 26 }, (_, i) => Math.round(((i * 7705) / 26) * 10) / 10);
    const out = formatJson({ items: [{ chapters: { starts } }] });
    expect(out).toContain('"starts": [\n          0, 296.3, 592.7,');
    expect(biomeFormat(out)).toBe(out);
    const wide = formatJson({ starts: Array.from({ length: 400 }, (_, i) => i * 1.5) });
    expect(wide.split('\n').length).toBeGreaterThan(5);
    expect(biomeFormat(wide)).toBe(wide);
  });

  it('counts wide characters as two columns', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('día')).toBe(3);
  });
});
