import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrations } from '../src/migrations.generated.ts';

const dir = new URL('../migrations/', import.meta.url);

describe('embedded migrations', () => {
  it('match migrations/*.sql exactly (rerun scripts/embed-migrations.mjs after editing SQL)', () => {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files.every((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
    expect(migrations.map((m) => `${String(m.version).padStart(4, '0')}_${m.name}.sql`)).toEqual(files);
    for (const m of migrations) {
      const file = `${String(m.version).padStart(4, '0')}_${m.name}.sql`;
      expect(m.sql, file).toBe(readFileSync(new URL(file, dir), 'utf8'));
    }
  });

  it('are numbered 1..n without gaps and never drop anything', () => {
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_, i) => i + 1));
    for (const m of migrations) {
      const code = m.sql.replace(/--.*$/gm, '');
      expect(code).not.toMatch(/\b(drop|truncate)\b/i);
      expect(code).not.toMatch(/\$vid2context_(outer|migration)\$/);
      expect(code).toContain('{{schema}}');
    }
  });
});
