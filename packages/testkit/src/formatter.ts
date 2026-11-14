/**
 * Conformance suite for output formatters: every real fixture renders without
 * throwing, output is non-empty and deterministic, and the formatter declares
 * a mime type and file extension.
 */
import type { FormatOptions, Formatter, VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { loadContextFixtures } from './fixtures.ts';

/** Option sets every formatter must accept. */
export const FORMAT_OPTION_SETS: FormatOptions[] = [
  {},
  { timestamps: true },
  { timestamps: true, linkTimestamps: false },
  { includeComments: true, includeVisual: true },
  { maxTokens: 2000 },
];

/**
 * @param contexts Real VideoContext fixtures. Default: every file in tests/fixtures/contexts.
 */
export function describeFormatter(formatter: Formatter, contexts?: { file: string; context: VideoContext }[]): void {
  const fixtures = contexts ?? loadContextFixtures();
  describe(`formatter conformance: ${formatter.id}`, () => {
    it('declares id, description, mimeType and extension', () => {
      expect(formatter.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(formatter.description.length).toBeGreaterThan(0);
      expect(formatter.mimeType).toMatch(/^[a-z]+\/[a-z0-9.+-]+/i);
      expect(formatter.extension).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)*$/i);
    });

    for (const { file, context } of fixtures) {
      it(`renders ${file} non-empty and deterministically under every option set`, () => {
        for (const opts of FORMAT_OPTION_SETS) {
          const a = formatter.render(structuredClone(context), opts);
          const b = formatter.render(structuredClone(context), opts);
          expect(typeof a).toBe('string');
          expect(a.trim().length, `empty output with ${JSON.stringify(opts)}`).toBeGreaterThan(0);
          expect(b, `output differs between two runs with ${JSON.stringify(opts)}`).toBe(a);
        }
      });
    }

    if (formatter.renderMany && fixtures.length > 1) {
      it('renderMany combines every fixture deterministically', () => {
        const all = fixtures.map((f) => f.context);
        const a = formatter.renderMany?.(structuredClone(all), {}) ?? '';
        const b = formatter.renderMany?.(structuredClone(all), {}) ?? '';
        expect(a.trim().length).toBeGreaterThan(0);
        expect(b).toBe(a);
      });
    }
  });
}
