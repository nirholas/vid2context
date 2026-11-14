#!/usr/bin/env node
/**
 * Minimal JSON Schema check for deploy configs, with no dependencies:
 *
 *   node validate-json.mjs <schema.json> <file.json>
 *
 * Supports the keywords Railway's railway.schema.json uses: type, const,
 * enum, anyOf, oneOf, allOf, properties, required, additionalProperties,
 * items, minimum, maximum and local $ref. It is also strict about unknown
 * keys: a key the schema does not define is an error even where the schema
 * allows extra properties, so a misspelled setting is caught instead of
 * silently ignored by the platform.
 */
import { readFileSync } from 'node:fs';

const [schemaPath, filePath] = process.argv.slice(2);
if (!schemaPath || !filePath) {
  console.error('usage: node validate-json.mjs <schema.json> <file.json>');
  process.exit(2);
}
const root = JSON.parse(readFileSync(schemaPath, 'utf8'));
const doc = JSON.parse(readFileSync(filePath, 'utf8'));

function resolveRef(ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

/** Returns a list of error strings; empty means valid. */
function check(value, schema, path) {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path}: not allowed`];
  if (schema.$ref) return check(value, resolveRef(schema.$ref), path);
  const errors = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) return [`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const))
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  for (const sub of schema.allOf ?? []) errors.push(...check(value, sub, path));
  for (const key of ['anyOf', 'oneOf']) {
    if (!schema[key]) continue;
    const results = schema[key].map((sub) => check(value, sub, path));
    const passing = results.filter((r) => r.length === 0).length;
    if (passing === 0) {
      const closest = results.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(...closest);
    } else if (key === 'oneOf' && passing > 1) {
      errors.push(`${path}: matches more than one oneOf branch`);
    }
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) if (!(req in value)) errors.push(`${path}: missing required "${req}"`);
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (key in props) errors.push(...check(child, props[key], childPath));
      else if (key === '$schema') continue;
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...check(child, schema.additionalProperties, childPath));
      } else if (schema.properties || schema.additionalProperties === false) {
        errors.push(`${childPath}: unknown key`);
      }
    }
  }
  if (Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
    value.forEach((item, i) => {
      errors.push(...check(item, schema.items, `${path}[${i}]`));
    });
  }
  return errors;
}

const errors = check(doc, root, '$');
if (errors.length) {
  for (const e of errors) console.error(`${filePath}: ${e}`);
  process.exit(1);
}
console.error(`${filePath}: valid against ${schemaPath}`);
