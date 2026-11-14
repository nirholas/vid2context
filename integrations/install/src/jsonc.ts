/**
 * A small JSON-with-comments scanner that keeps byte offsets, so the installer
 * can insert, replace or remove one entry and leave every other byte of the
 * user's file exactly as it was (comments, key order, spacing). Re-serializing
 * the whole file would lose comments and reformat it, which is why a plain
 * JSON.parse plus JSON.stringify is not used.
 */

export interface JsonMember {
  key: string;
  /** Offset of the opening quote of the key. */
  keyStart: number;
  value: JsonNode;
}

export type JsonNode =
  | { kind: 'object'; start: number; end: number; members: JsonMember[]; trailingComma: boolean }
  | { kind: 'array'; start: number; end: number; items: JsonNode[] }
  | { kind: 'scalar'; start: number; end: number; value: string | number | boolean | null };

export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} at line ${line}, column ${column}`);
  }
}

export interface ParseOptions {
  /** Allow // and /* *\/ comments and trailing commas (JSONC, as VS Code reads it). */
  comments: boolean;
}

export function parseJsonc(text: string, opts: ParseOptions): JsonNode {
  let i = 0;

  const fail = (message: string, at = i): never => {
    const before = text.slice(0, at).split('\n');
    throw new JsonParseError(message, at, before.length, (before.at(-1)?.length ?? 0) + 1);
  };

  const skip = (): void => {
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') {
        i++;
      } else if (c === '/' && text[i + 1] === '/') {
        if (!opts.comments) fail('Comments are not allowed in this file');
        while (i < text.length && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        if (!opts.comments) fail('Comments are not allowed in this file');
        const close = text.indexOf('*/', i + 2);
        if (close < 0) fail('Unterminated comment');
        i = close + 2;
      } else {
        break;
      }
    }
  };

  const readString = (): string => {
    const start = i;
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
      } else if (c === '"') {
        i++;
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          return fail('Invalid string escape', start);
        }
      } else if (c === '\n') {
        fail('Unterminated string', start);
      } else {
        i++;
      }
    }
    return fail('Unterminated string', start);
  };

  const readValue = (): JsonNode => {
    skip();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const members: JsonMember[] = [];
      let trailingComma = false;
      skip();
      if (text[i] === '}') {
        i++;
        return { kind: 'object', start, end: i, members, trailingComma };
      }
      for (;;) {
        skip();
        if (text[i] === '}' && members.length > 0 && opts.comments) {
          trailingComma = true;
          i++;
          return { kind: 'object', start, end: i, members, trailingComma };
        }
        if (text[i] !== '"') fail('Expected a property name in double quotes');
        const keyStart = i;
        const key = readString();
        skip();
        if (text[i] !== ':') fail("Expected ':' after the property name");
        i++;
        const value = readValue();
        members.push({ key, keyStart, value });
        skip();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return { kind: 'object', start, end: i, members, trailingComma };
        }
        fail("Expected ',' or '}'");
      }
    }
    if (c === '[') {
      i++;
      const items: JsonNode[] = [];
      skip();
      if (text[i] === ']') {
        i++;
        return { kind: 'array', start, end: i, items };
      }
      for (;;) {
        skip();
        if (text[i] === ']' && items.length > 0 && opts.comments) {
          i++;
          return { kind: 'array', start, end: i, items };
        }
        items.push(readValue());
        skip();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return { kind: 'array', start, end: i, items };
        }
        fail("Expected ',' or ']'");
      }
    }
    if (c === '"') {
      const value = readString();
      return { kind: 'scalar', start, end: i, value };
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (!m) return fail(i >= text.length ? 'Unexpected end of file' : `Unexpected character '${c}'`);
    i += m[0].length;
    return { kind: 'scalar', start, end: i, value: JSON.parse(m[0]) as string | number | boolean | null };
  };

  const root = readValue();
  skip();
  if (i < text.length) fail('Unexpected content after the end of the document');
  return root;
}

/** Plain JavaScript value of a node. */
export function toValue(node: JsonNode): unknown {
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'array') return node.items.map(toValue);
  const out: Record<string, unknown> = {};
  for (const m of node.members) out[m.key] = toValue(m.value);
  return out;
}

export function member(node: JsonNode, key: string): JsonMember | undefined {
  return node.kind === 'object' ? node.members.find((m) => m.key === key) : undefined;
}

/** Indent unit used by the file (the first indented line), defaulting to two spaces. */
export function detectIndent(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m?.[1] ?? '  ';
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

function lineEnding(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** JSON for a value, indented so it sits at `baseIndent` inside the file. */
function render(value: unknown, unit: string, baseIndent: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(eol + baseIndent);
}

/**
 * Text with `key: value` set inside `obj`. Replaces the value of an existing
 * member, or appends a new member after the last one, matching the file's
 * indentation and line endings.
 */
export function setMember(text: string, obj: JsonNode, key: string, value: unknown): string {
  if (obj.kind !== 'object') throw new Error('setMember needs an object node');
  const unit = detectIndent(text);
  const eol = lineEnding(text);
  const existing = obj.members.find((m) => m.key === key);
  if (existing) {
    const indent = lineIndentAt(text, existing.keyStart);
    return text.slice(0, existing.value.start) + render(value, unit, indent, eol) + text.slice(existing.value.end);
  }
  const objIndent = lineIndentAt(text, obj.start);
  const last = obj.members.at(-1);
  if (!last) {
    const indent = objIndent + unit;
    const entry = `${eol}${indent}${JSON.stringify(key)}: ${render(value, unit, indent, eol)}${eol}${objIndent}`;
    return text.slice(0, obj.start + 1) + entry + text.slice(obj.end - 1);
  }
  const indent = lineIndentAt(text, last.keyStart);
  const entry = `${JSON.stringify(key)}: ${render(value, unit, indent, eol)}`;
  if (obj.trailingComma) {
    // Insert after the existing trailing comma and keep one after the new member too.
    const comma = text.indexOf(',', last.value.end);
    return `${text.slice(0, comma + 1)}${eol}${indent}${entry},${text.slice(comma + 1)}`;
  }
  return `${text.slice(0, last.value.end)},${eol}${indent}${entry}${text.slice(last.value.end)}`;
}

/** Text with member `key` removed from `obj`, the exact inverse of setMember's append. */
export function removeMember(text: string, obj: JsonNode, key: string): string {
  if (obj.kind !== 'object') throw new Error('removeMember needs an object node');
  const idx = obj.members.findIndex((m) => m.key === key);
  if (idx < 0) return text;
  const target = obj.members[idx] as JsonMember;
  if (obj.members.length === 1) {
    return text.slice(0, obj.start + 1) + text.slice(obj.end - 1);
  }
  if (idx > 0) {
    const prev = obj.members[idx - 1] as JsonMember;
    let end = target.value.end;
    if (obj.trailingComma && idx === obj.members.length - 1) {
      // Keep the previous member's comma; drop ours.
      end = text.indexOf(',', end) + 1;
      const commaAfterPrev = text.indexOf(',', prev.value.end);
      return text.slice(0, commaAfterPrev + 1) + text.slice(end);
    }
    return text.slice(0, prev.value.end) + text.slice(end);
  }
  const next = obj.members[1] as JsonMember;
  const lineStart = text.lastIndexOf('\n', target.keyStart - 1) + 1;
  const nextLineStart = text.lastIndexOf('\n', next.keyStart - 1) + 1;
  // Both on their own lines: drop whole lines. Otherwise drop up to the next key.
  if (/^[ \t]*$/.test(text.slice(lineStart, target.keyStart)) && nextLineStart > lineStart) {
    return text.slice(0, lineStart) + text.slice(nextLineStart);
  }
  return text.slice(0, target.keyStart) + text.slice(next.keyStart);
}
