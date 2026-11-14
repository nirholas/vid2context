/**
 * A tiny schema language. The same definitions drive the validator (precise
 * errors with JSON paths) and the JSON Schema committed for editors, so the
 * two can never drift apart.
 */

export type SchemaNode =
  | { kind: 'string'; description?: string; pattern?: string; minLength?: number }
  | { kind: 'boolean'; description?: string }
  | { kind: 'integer'; description?: string; minimum?: number }
  | { kind: 'literal'; description?: string; value: string | number }
  | { kind: 'enum'; description?: string; values: string[] }
  | { kind: 'array'; description?: string; items: SchemaNode }
  | {
      kind: 'object';
      description?: string;
      props: Record<string, SchemaNode>;
      required?: string[];
      /** Schema for keys not listed in `props`. Omit to refuse unknown keys. */
      additional?: SchemaNode;
      /** Pattern every additional key must match. */
      keyPattern?: string;
    }
  | { kind: 'union'; description?: string; options: SchemaNode[] };

export const s = {
  string: (description?: string, extra: { pattern?: string; minLength?: number } = {}): SchemaNode => ({
    kind: 'string',
    description,
    ...extra,
  }),
  boolean: (description?: string): SchemaNode => ({ kind: 'boolean', description }),
  integer: (description?: string, minimum?: number): SchemaNode => ({ kind: 'integer', description, minimum }),
  literal: (value: string | number, description?: string): SchemaNode => ({ kind: 'literal', value, description }),
  enum: (values: string[], description?: string): SchemaNode => ({ kind: 'enum', values, description }),
  array: (items: SchemaNode, description?: string): SchemaNode => ({ kind: 'array', items, description }),
  object: (
    props: Record<string, SchemaNode>,
    opts: { description?: string; required?: string[]; additional?: SchemaNode; keyPattern?: string } = {},
  ): SchemaNode => ({ kind: 'object', props, ...opts }),
  union: (options: SchemaNode[], description?: string): SchemaNode => ({ kind: 'union', options, description }),
};

export interface SchemaError {
  path: string;
  message: string;
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function describe(node: SchemaNode): string {
  switch (node.kind) {
    case 'string':
      return 'a string';
    case 'boolean':
      return 'true or false';
    case 'integer':
      return node.minimum === undefined ? 'an integer' : `an integer >= ${node.minimum}`;
    case 'literal':
      return JSON.stringify(node.value);
    case 'enum':
      return `one of ${node.values.join(', ')}`;
    case 'array':
      return `a list of ${describe(node.items).replace(/^an? /, '')}s`;
    case 'object':
      return 'an object';
    case 'union':
      return node.options.map(describe).join(' or ');
  }
}

/** Which JSON types a node can accept, used to route a union to its matching option. */
function acceptsType(node: SchemaNode, type: string): boolean {
  switch (node.kind) {
    case 'string':
    case 'enum':
      return type === 'string';
    case 'boolean':
      return type === 'boolean';
    case 'integer':
      return type === 'integer';
    case 'literal':
      return type === jsonType(node.value);
    case 'array':
      return type === 'array';
    case 'object':
      return type === 'object';
    case 'union':
      return node.options.some((o) => acceptsType(o, type));
  }
}

export function joinPath(path: string, key: string): string {
  const k = /^[A-Za-z_$][\w$-]*$/.test(key) ? key : JSON.stringify(key);
  return path ? `${path}.${k}` : k;
}

/** Validate a value against a node. Returns every error found, each with its JSON path. */
export function check(node: SchemaNode, value: unknown, path = ''): SchemaError[] {
  const at = path || '(root)';
  const type = jsonType(value);
  switch (node.kind) {
    case 'string': {
      if (type !== 'string') return [{ path: at, message: `expected ${describe(node)}, got ${type}` }];
      const v = value as string;
      if (node.minLength !== undefined && v.length < node.minLength) return [{ path: at, message: 'must not be empty' }];
      if (node.pattern && !new RegExp(node.pattern).test(v)) {
        return [{ path: at, message: `${JSON.stringify(v)} does not match ${node.pattern}` }];
      }
      return [];
    }
    case 'boolean':
    case 'integer':
      if (type !== node.kind) return [{ path: at, message: `expected ${describe(node)}, got ${type}` }];
      if (node.kind === 'integer' && node.minimum !== undefined && (value as number) < node.minimum) {
        return [{ path: at, message: `expected ${describe(node)}, got ${value}` }];
      }
      return [];
    case 'literal':
      return value === node.value ? [] : [{ path: at, message: `expected ${describe(node)}, got ${JSON.stringify(value)}` }];
    case 'enum':
      return type === 'string' && node.values.includes(value as string)
        ? []
        : [{ path: at, message: `expected ${describe(node)}, got ${JSON.stringify(value)}` }];
    case 'array': {
      if (type !== 'array') return [{ path: at, message: `expected ${describe(node)}, got ${type}` }];
      return (value as unknown[]).flatMap((item, i) => check(node.items, item, `${path}[${i}]`));
    }
    case 'object': {
      if (type !== 'object') return [{ path: at, message: `expected an object, got ${type}` }];
      const obj = value as Record<string, unknown>;
      const errors: SchemaError[] = [];
      for (const req of node.required ?? []) {
        if (!(req in obj)) errors.push({ path: joinPath(path, req), message: 'is required' });
      }
      for (const [key, v] of Object.entries(obj)) {
        const child = node.props[key];
        if (child) {
          errors.push(...check(child, v, joinPath(path, key)));
        } else if (node.additional) {
          if (node.keyPattern && !new RegExp(node.keyPattern).test(key)) {
            errors.push({ path: joinPath(path, key), message: `key does not match ${node.keyPattern}` });
          } else {
            errors.push(...check(node.additional, v, joinPath(path, key)));
          }
        } else {
          errors.push({
            path: joinPath(path, key),
            message: `unknown key; expected one of ${Object.keys(node.props).join(', ')}`,
          });
        }
      }
      return errors;
    }
    case 'union': {
      const candidates = node.options.filter((o) => acceptsType(o, type));
      if (candidates.length === 1 && candidates[0]) return check(candidates[0], value, path);
      for (const o of candidates) if (check(o, value, path).length === 0) return [];
      return [{ path: at, message: `expected ${describe(node)}` }];
    }
  }
}

/** Convert a node to JSON Schema (draft-07) for editor autocomplete. */
export function toJsonSchema(node: SchemaNode): Record<string, unknown> {
  const base: Record<string, unknown> = node.description ? { description: node.description } : {};
  switch (node.kind) {
    case 'string':
      return {
        type: 'string',
        ...base,
        ...(node.pattern ? { pattern: node.pattern } : {}),
        ...(node.minLength !== undefined ? { minLength: node.minLength } : {}),
      };
    case 'boolean':
      return { type: 'boolean', ...base };
    case 'integer':
      return { type: 'integer', ...base, ...(node.minimum !== undefined ? { minimum: node.minimum } : {}) };
    case 'literal':
      return { const: node.value, ...base };
    case 'enum':
      return { type: 'string', enum: node.values, ...base };
    case 'array':
      return { type: 'array', ...base, items: toJsonSchema(node.items) };
    case 'object': {
      const out: Record<string, unknown> = {
        type: 'object',
        ...base,
        properties: Object.fromEntries(Object.entries(node.props).map(([k, v]) => [k, toJsonSchema(v)])),
      };
      if (node.required && node.required.length > 0) out.required = node.required;
      if (node.additional) {
        out.additionalProperties = toJsonSchema(node.additional);
        if (node.keyPattern) out.propertyNames = { pattern: node.keyPattern };
      } else {
        out.additionalProperties = false;
      }
      return out;
    }
    case 'union':
      return { ...base, anyOf: node.options.map(toJsonSchema) };
  }
}
