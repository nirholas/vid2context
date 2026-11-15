import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { templates } from '../src/templates/index.ts';
import { templatePrompts } from '../src/templates/prompts.generated.ts';

const dir = new URL('../src/templates/', import.meta.url);

describe('template prompt files', () => {
  it('prompts.generated.ts matches src/templates/*.md exactly (rerun scripts/embed-templates.mjs after editing)', () => {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    expect(Object.keys(templatePrompts).sort()).toEqual(files.map((f) => f.slice(0, -3)));
    for (const file of files) {
      expect(templatePrompts[file.slice(0, -3)], file).toBe(readFileSync(new URL(file, dir), 'utf8').trimEnd());
    }
  });

  it('every template uses its own .md file as its instructions, and every .md file belongs to a template', () => {
    expect(Object.keys(templates).sort()).toEqual(Object.keys(templatePrompts).sort());
    for (const t of Object.values(templates)) {
      expect(t.instructions).toBe(templatePrompts[t.id]);
      expect(t.instructions.startsWith('## ')).toBe(true);
    }
  });
});
