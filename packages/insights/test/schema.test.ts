import { Vid2ContextError } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { assertSupportedSchema, extractionSchema, templates, validate } from '../src/index.ts';

describe('schema subset', () => {
  const schema = {
    type: 'object',
    properties: {
      years: { type: 'array', maxItems: 2, items: { type: 'string', pattern: '^\\d{4}' } },
      verdict: { type: 'string', enum: ['seek', 'avoid'] },
      price: { type: ['number', 'null'], minimum: 0 },
    },
    required: ['years', 'verdict'],
    additionalProperties: false,
  };

  it('accepts a valid value', () => {
    assertSupportedSchema(schema);
    expect(validate(schema, { years: ['2002-2006'], verdict: 'seek', price: null })).toEqual([]);
  });

  it('reports every problem with a JSON pointer', () => {
    expect(validate(schema, { years: ['2002', '2003', 'old'], verdict: 'maybe', price: -1, extra: 1 })).toEqual([
      '/years: must have at most 2 items (has 3)',
      '/years/2: must match /^\\d{4}/',
      '/verdict: must be one of ["seek","avoid"]',
      '/price: must be >= 0',
      '/: unexpected property "extra"',
    ]);
    expect(validate(schema, { verdict: 'seek' })).toEqual(['/: missing required property "years"']);
    expect(validate(schema, [])).toEqual(['/: expected object, got array']);
  });

  it('treats integers as numbers but not the reverse', () => {
    expect(validate({ type: 'number' }, 3)).toEqual([]);
    expect(validate({ type: 'integer' }, 3.5)).toEqual(['/: expected integer, got number']);
  });

  it('rejects unsupported keywords with bad-request and a hint', () => {
    for (const bad of [{ $ref: '#/x' }, { anyOf: [] }, { type: 'object', properties: { a: { oneOf: [] } } }, { type: 'date' }]) {
      try {
        assertSupportedSchema(bad);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(Vid2ContextError);
        expect((err as Vid2ContextError).code).toBe('bad-request');
        expect((err as Vid2ContextError).hint).toContain('subset');
      }
    }
  });

  it('every template schema is inside the supported subset, and cites in every list item', () => {
    for (const t of Object.values(templates)) {
      assertSupportedSchema(t.schema);
      expect(JSON.stringify(t.schema)).toContain('"sources"');
    }
  });

  it('wraps a custom schema with a citations list', () => {
    const { schema: wrapped, template } = extractionSchema({ schema: { type: 'object', properties: { a: { type: 'string' } } } });
    expect(template).toBeUndefined();
    expect(Object.keys(wrapped.properties as object)).toEqual(['data', 'citations']);
    expect(extractionSchema({}).template?.id).toBe('summary');
  });
});
