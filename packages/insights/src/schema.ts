/**
 * A small JSON Schema validator for the subset extraction supports. Model
 * output is checked against it, and a failed check drives one repair call.
 * Written here instead of depending on ajv so the package stays small and
 * runs unchanged on Node, Workers and in the browser.
 *
 * Supported: type (one or a list of: object, array, string, number, integer,
 * boolean, null), properties, required, additionalProperties (boolean or a
 * schema), items (one schema), enum, const, minItems, maxItems, uniqueItems,
 * minLength, maxLength, pattern, minimum, maximum, exclusiveMinimum,
 * exclusiveMaximum. Ignored as annotations: title, description, default,
 * examples, format, $schema, $id, $comment, readOnly, writeOnly, deprecated.
 * Anything else ($ref, anyOf, oneOf, allOf, not, if/then/else,
 * patternProperties, prefixItems, ...) is rejected up front with bad-request.
 */
import { Vid2ContextError } from '@vid2context/core';

export type JsonSchema = Record<string, unknown>;

const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);
const ANNOTATIONS = new Set([
  'title',
  'description',
  'default',
  'examples',
  'format',
  '$schema',
  '$id',
  '$comment',
  'readOnly',
  'writeOnly',
  'deprecated',
]);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export const SUPPORTED_KEYWORDS = [...KEYWORDS];
const MAX_DEPTH = 12;
const MAX_SCHEMA_BYTES = 32_000;

function unsupported(message: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, {
    hint: `Extraction supports this JSON Schema subset: ${SUPPORTED_KEYWORDS.join(', ')} (plus annotations such as title and description). Inline any $ref and replace anyOf/oneOf with a type list or an enum.`,
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throw bad-request when the schema uses anything outside the supported subset. */
export function assertSupportedSchema(schema: unknown, path = '#', depth = 0): asserts schema is JsonSchema {
  if (depth === 0 && JSON.stringify(schema ?? null).length > MAX_SCHEMA_BYTES) {
    throw unsupported(`The schema is larger than ${MAX_SCHEMA_BYTES} bytes.`);
  }
  if (depth > MAX_DEPTH) throw unsupported(`The schema nests deeper than ${MAX_DEPTH} levels at ${path}.`);
  if (!isObject(schema)) throw unsupported(`The schema at ${path} must be an object.`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key))
      throw unsupported(`The schema keyword "${key}" at ${path} is not supported.`);
  }
  const t = schema.type;
  if (t !== undefined) {
    const list = Array.isArray(t) ? t : [t];
    if (list.length === 0 || list.some((x) => typeof x !== 'string' || !TYPES.has(x))) {
      throw unsupported(`"type" at ${path} must be one of ${[...TYPES].join(', ')}, or a list of them.`);
    }
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) throw unsupported(`"properties" at ${path} must be an object.`);
    for (const [k, v] of Object.entries(schema.properties)) assertSupportedSchema(v, `${path}/properties/${k}`, depth + 1);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string'))) {
    throw unsupported(`"required" at ${path} must be a list of property names.`);
  }
  if (isObject(schema.additionalProperties)) {
    assertSupportedSchema(schema.additionalProperties, `${path}/additionalProperties`, depth + 1);
  } else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    throw unsupported(`"additionalProperties" at ${path} must be a boolean or a schema.`);
  }
  if (schema.items !== undefined) {
    if (!isObject(schema.items)) throw unsupported(`"items" at ${path} must be one schema (tuple forms are not supported).`);
    assertSupportedSchema(schema.items, `${path}/items`, depth + 1);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw unsupported(`"enum" at ${path} must be a list.`);
  for (const k of [
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
  ]) {
    if (schema[k] !== undefined && (typeof schema[k] !== 'number' || !Number.isFinite(schema[k]))) {
      throw unsupported(`"${k}" at ${path} must be a number.`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') throw unsupported(`"pattern" at ${path} must be a string.`);
    try {
      new RegExp(schema.pattern, 'u');
    } catch {
      throw unsupported(`"pattern" at ${path} is not a valid regular expression.`);
    }
  }
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const got = typeOf(v);
  return want === got || (want === 'number' && got === 'integer');
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const escapePointer = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
const MAX_ERRORS = 25;

/** Validate a value against a supported schema. Returns errors as "<JSON pointer>: <problem>", empty when valid. */
export function validate(schema: JsonSchema, value: unknown, path = ''): string[] {
  const errors: string[] = [];
  walk(schema, value, path, errors);
  return errors.slice(0, MAX_ERRORS);
}

function walk(s: JsonSchema, v: unknown, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) return;
  const at = path || '/';
  const push = (msg: string) => errors.push(`${at}: ${msg}`);
  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    if (!types.some((t) => typeMatches(t, v))) {
      push(`expected ${types.join(' or ')}, got ${typeOf(v)}`);
      return;
    }
  }
  if (s.const !== undefined && !equal(s.const, v)) push(`must equal ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => equal(e, v))) push(`must be one of ${JSON.stringify(s.enum)}`);
  if (typeof v === 'string') {
    const len = [...v].length;
    if (typeof s.minLength === 'number' && len < s.minLength) push(`must be at least ${s.minLength} characters`);
    if (typeof s.maxLength === 'number' && len > s.maxLength) push(`must be at most ${s.maxLength} characters (has ${len})`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) push(`must match /${s.pattern}/`);
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) push(`must be >= ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) push(`must be <= ${s.maximum}`);
    if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) push(`must be > ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) push(`must be < ${s.exclusiveMaximum}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) push(`must have at least ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) push(`must have at most ${s.maxItems} items (has ${v.length})`);
    if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) push('items must be unique');
    if (isObject(s.items)) {
      for (const [i, item] of v.entries()) walk(s.items as JsonSchema, item, `${path}/${i}`, errors);
    }
  }
  if (isObject(v)) {
    const props = isObject(s.properties) ? (s.properties as Record<string, JsonSchema>) : {};
    if (Array.isArray(s.required)) {
      for (const r of s.required as string[]) if (!(r in v)) push(`missing required property "${r}"`);
    }
    for (const [k, val] of Object.entries(v)) {
      const sub = props[k];
      if (sub) walk(sub, val, `${path}/${escapePointer(k)}`, errors);
      else if (s.additionalProperties === false) push(`unexpected property "${k}"`);
      else if (isObject(s.additionalProperties)) walk(s.additionalProperties, val, `${path}/${escapePointer(k)}`, errors);
    }
  }
}
