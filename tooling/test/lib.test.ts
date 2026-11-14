import { describe, expect, it } from 'vitest';
import { formatReport, groupOf, position, stripCode } from '../checks/lib.mjs';

describe('stripCode', () => {
  it('blanks comments but keeps every offset and newline', () => {
    const src = "a(); // process.env\n/* fetch(\n */ b('x');";
    const out = stripCode(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).not.toMatch(/process|fetch/);
    expect(out).toContain("b('x')");
  });

  it('blanks strings on request and keeps template expressions as code', () => {
    // The input is source code that contains a template literal.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source as test input
    const out = stripCode("const s = 'process.env'; const t = `a ${process.env.X} b`;", { strings: true });
    expect(out.match(/process\.env/g)).toHaveLength(1);
    expect(out).toMatch(/\$\{process\.env\.X\}/);
  });

  it('treats a regex literal with a quote inside as a regex, not a string', () => {
    const out = stripCode("const r = /'/g; process.env.A;", { strings: true });
    expect(out).toContain('process.env.A');
  });

  it('treats a slash after a value as division', () => {
    const out = stripCode("const half = total / 2; // ' comment", { strings: true });
    expect(out).toContain('total / 2');
    expect(out).not.toContain('comment');
  });
});

describe('report', () => {
  it('positions offsets as 1-based line and column', () => {
    expect(position('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });

  it('groups by workspace or top directory and caps lines per file', () => {
    expect(groupOf('providers/youtube/src/index.ts')).toBe('providers/youtube');
    expect(groupOf('docs/ci.md')).toBe('docs');
    expect(groupOf('README.md')).toBe('.');
    const findings = Array.from({ length: 7 }, (_, i) => ({
      check: 'no-dashes',
      path: 'docs/a.md',
      line: i + 1,
      column: 1,
      message: 'm',
    }));
    const text = formatReport(findings);
    expect(text.split('\n')[0]).toBe('docs/');
    expect(text).toContain('...and 2 more');
  });
});
