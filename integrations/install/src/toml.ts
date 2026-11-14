/**
 * Minimal TOML support for Codex's config.toml: a reader that validates the
 * whole file and returns its data, and text-level edits of one table
 * (`[mcp_servers.vid2context]` plus its sub-tables) that leave every other
 * line, comment and table untouched. It covers the TOML that config files
 * use (tables, arrays of tables, dotted keys, strings, numbers, booleans,
 * dates, arrays, inline tables); anything else is a parse error, and the
 * installer then refuses to touch the file.
 */

export class TomlParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} at line ${line}`);
  }
}

type Table = Record<string, unknown>;

const BARE_KEY = /^[A-Za-z0-9_-]+/;

export function parseToml(text: string): Table {
  const root: Table = {};
  let current: Table = root;
  let i = 0;
  let line = 1;
  const defined = new Set<string>();

  const fail = (message: string): never => {
    throw new TomlParseError(message, line);
  };

  const skipWs = (): void => {
    while (text[i] === ' ' || text[i] === '\t') i++;
  };
  const skipComment = (): void => {
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++;
  };
  /** Whitespace, newlines and comments (inside arrays). */
  const skipAll = (): void => {
    for (;;) {
      skipWs();
      skipComment();
      if (text[i] === '\n') {
        line++;
        i++;
      } else if (text[i] === '\r' && text[i + 1] === '\n') {
        line++;
        i += 2;
      } else {
        return;
      }
    }
  };
  const endOfLine = (): void => {
    skipWs();
    skipComment();
    if (i >= text.length) return;
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    if (text[i] !== '\n') fail('Expected the end of the line');
    i++;
    line++;
  };

  const readBasicString = (): string => {
    if (text.startsWith('"""', i)) {
      i += 3;
      if (text[i] === '\n') {
        i++;
        line++;
      }
      let out = '';
      for (;;) {
        if (i >= text.length) fail('Unterminated multi-line string');
        if (text.startsWith('"""', i) && !text.startsWith('""""', i + 1)) {
          i += 3;
          return out;
        }
        const c = text[i] as string;
        if (c === '\\') {
          if (/^\\[ \t]*\r?\n/.test(text.slice(i))) {
            i++;
            while (/[ \t\r\n]/.test(text[i] ?? '')) {
              if (text[i] === '\n') line++;
              i++;
            }
            continue;
          }
          out += readEscape();
          continue;
        }
        if (c === '\n') line++;
        out += c;
        i++;
      }
    }
    i++;
    let out = '';
    for (;;) {
      const c = text[i];
      if (c === undefined || c === '\n') fail('Unterminated string');
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        out += readEscape();
        continue;
      }
      out += c;
      i++;
    }
  };

  const readEscape = (): string => {
    const c = text[i + 1];
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
    if (c !== undefined && c in simple) {
      i += 2;
      return simple[c] as string;
    }
    if (c === 'u' || c === 'U') {
      const len = c === 'u' ? 4 : 8;
      const hex = text.slice(i + 2, i + 2 + len);
      if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) fail('Invalid unicode escape');
      i += 2 + len;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    return fail('Invalid escape');
  };

  const readLiteralString = (): string => {
    if (text.startsWith("'''", i)) {
      i += 3;
      if (text[i] === '\n') {
        i++;
        line++;
      }
      const close = text.indexOf("'''", i);
      if (close < 0) fail('Unterminated multi-line literal string');
      let end = close;
      while (text[end + 3] === "'") end++;
      const out = text.slice(i, end);
      line += out.split('\n').length - 1;
      i = end + 3;
      return out;
    }
    i++;
    const close = text.indexOf("'", i);
    const nl = text.indexOf('\n', i);
    if (close < 0 || (nl >= 0 && nl < close)) fail('Unterminated literal string');
    const out = text.slice(i, close);
    i = close + 1;
    return out;
  };

  const readKeyPart = (): string => {
    skipWs();
    if (text[i] === '"') return readBasicString();
    if (text[i] === "'") return readLiteralString();
    const m = BARE_KEY.exec(text.slice(i));
    if (!m) return fail('Expected a key');
    i += m[0].length;
    return m[0];
  };

  const readKey = (): string[] => {
    const parts = [readKeyPart()];
    for (;;) {
      skipWs();
      if (text[i] !== '.') return parts;
      i++;
      parts.push(readKeyPart());
    }
  };

  const readValue = (): unknown => {
    skipWs();
    const c = text[i];
    if (c === '"') return readBasicString();
    if (c === "'") return readLiteralString();
    if (c === '[') {
      i++;
      const items: unknown[] = [];
      for (;;) {
        skipAll();
        if (text[i] === ']') {
          i++;
          return items;
        }
        items.push(readValue());
        skipAll();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return items;
        }
        fail("Expected ',' or ']' in array");
      }
    }
    if (c === '{') {
      i++;
      const table: Table = {};
      skipWs();
      if (text[i] === '}') {
        i++;
        return table;
      }
      for (;;) {
        const key = readKey();
        skipWs();
        if (text[i] !== '=') fail("Expected '=' in inline table");
        i++;
        assign(table, key, readValue());
        skipWs();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return table;
        }
        fail("Expected ',' or '}' in inline table");
      }
    }
    const rest = text.slice(i, i + 80);
    const m =
      /^(?:true|false)(?![A-Za-z0-9_-])/.exec(rest) ??
      /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/.exec(rest) ??
      /^\d{2}:\d{2}:\d{2}(?:\.\d+)?/.exec(rest) ??
      /^[+-]?(?:inf|nan)/.exec(rest) ??
      /^(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+)/.exec(rest) ??
      /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest);
    if (!m) return fail('Invalid value');
    i += m[0].length;
    const raw = m[0];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(?:\d|inf|nan)/.test(raw) && !raw.includes(':') && !/^\d{4}-/.test(raw)) return Number(raw.replace(/_/g, ''));
    return raw;
  };

  const assign = (table: Table, key: string[], value: unknown): void => {
    let t = table;
    for (const part of key.slice(0, -1)) {
      const next = t[part];
      if (next === undefined) t[part] = {};
      else if (typeof next !== 'object' || next === null || Array.isArray(next)) fail(`Key '${part}' is not a table`);
      t = t[part] as Table;
    }
    const last = key.at(-1) as string;
    if (last in t) fail(`Duplicate key '${key.join('.')}'`);
    t[last] = value;
  };

  const openTable = (path: string[], arrayOfTables: boolean): Table => {
    let t = root;
    path.forEach((part, idx) => {
      const isLast = idx === path.length - 1;
      let next = t[part];
      if (isLast && arrayOfTables) {
        if (next === undefined) next = t[part] = [];
        if (!Array.isArray(next)) fail(`Key '${part}' is not an array of tables`);
        const fresh: Table = {};
        (next as Table[]).push(fresh);
        t = fresh;
        return;
      }
      if (next === undefined) next = t[part] = {};
      if (Array.isArray(next)) next = next.at(-1);
      if (typeof next !== 'object' || next === null) fail(`Key '${part}' is not a table`);
      t = next as Table;
    });
    if (!arrayOfTables) {
      const id = JSON.stringify(path);
      if (defined.has(id)) fail(`Table [${path.join('.')}] is defined twice`);
      defined.add(id);
    }
    return t;
  };

  for (;;) {
    skipAll();
    if (i >= text.length) break;
    if (text[i] === '[') {
      const arrayOfTables = text[i + 1] === '[';
      i += arrayOfTables ? 2 : 1;
      const path = readKey();
      skipWs();
      if (text[i] !== ']' || (arrayOfTables && text[i + 1] !== ']')) fail('Expected the end of the table header');
      i += arrayOfTables ? 2 : 1;
      current = openTable(path, arrayOfTables);
      endOfLine();
      continue;
    }
    const key = readKey();
    skipWs();
    if (text[i] !== '=') fail("Expected '=' after the key");
    i++;
    assign(current, key, readValue());
    endOfLine();
  }
  return root;
}

/** A TOML string, quoted. JSON escapes are valid TOML basic-string escapes. */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

function tomlKey(key: string): string {
  return BARE_KEY.test(key) && BARE_KEY.exec(key)?.[0] === key ? key : tomlString(key);
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`);
    return entries.length ? `{ ${entries.join(', ')} }` : '{}';
  }
  throw new Error(`Cannot write ${String(value)} as TOML`);
}

/**
 * Renders `[prefix.name]` with scalar and array keys inline and nested tables
 * (env, http_headers) as sub-tables, the layout `codex mcp add` writes.
 */
export function renderTable(path: string[], table: Table, eol = '\n'): string {
  const header = path.map(tomlKey).join('.');
  const simple: string[] = [];
  const subs: string[] = [];
  for (const [k, v] of Object.entries(table)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      subs.push(renderTable([...path, k], v as Table, eol));
    } else {
      simple.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    }
  }
  return [[`[${header}]`, ...simple].join(eol), ...subs].join(eol + eol);
}

interface HeaderLine {
  start: number;
  path: string[];
}

/** Table header lines with their offsets. Parse the file first: this assumes valid TOML. */
function headerLines(text: string): HeaderLine[] {
  const out: HeaderLine[] = [];
  let offset = 0;
  let inMultiline: string | undefined;
  for (const raw of text.split('\n')) {
    const lineText = raw.replace(/\r$/, '');
    if (inMultiline) {
      if (lineText.includes(inMultiline)) inMultiline = undefined;
    } else {
      const m = /^[ \t]*\[(?!\[)(.+?)\][ \t]*(?:#.*)?$/.exec(lineText);
      if (m?.[1]) {
        out.push({ start: offset, path: splitKey(m[1]) });
      } else {
        for (const q of ['"""', "'''"]) {
          const n = lineText.split(q).length - 1;
          if (n % 2 === 1) inMultiline = q;
        }
      }
      if (/^[ \t]*\[\[/.test(lineText)) out.push({ start: offset, path: ['[['] });
    }
    offset += raw.length + 1;
  }
  return out;
}

function splitKey(key: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < key.length) {
    while (key[i] === ' ' || key[i] === '\t' || key[i] === '.') i++;
    if (key[i] === '"' || key[i] === "'") {
      const q = key[i] as string;
      let j = i + 1;
      while (j < key.length && key[j] !== q) j += key[j] === '\\' && q === '"' ? 2 : 1;
      const rawPart = key.slice(i, j + 1);
      parts.push(q === '"' ? (JSON.parse(rawPart) as string) : rawPart.slice(1, -1));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(key.slice(i));
      if (!m) break;
      parts.push(m[0]);
      i += m[0].length;
    }
  }
  return parts;
}

/** Offsets of the table at `path` and its sub-tables, up to the next unrelated header. */
export function findTable(text: string, path: string[]): { start: number; end: number } | undefined {
  const headers = headerLines(text);
  const isOurs = (h: HeaderLine) => path.every((p, idx) => h.path[idx] === p);
  const idx = headers.findIndex((h) => h.path.length === path.length && isOurs(h));
  if (idx < 0) return undefined;
  let end = text.length;
  for (const h of headers.slice(idx + 1)) {
    if (!isOurs(h)) {
      end = h.start;
      break;
    }
  }
  return { start: (headers[idx] as HeaderLine).start, end };
}

/** Text with the table at `path` replaced (keeping the blank lines after it) or appended. */
export function setTable(text: string, path: string[], table: Table): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rendered = renderTable(path, table, eol);
  const span = findTable(text, path);
  if (span) {
    const body = text.slice(span.start, span.end);
    const trailing = /\s*$/.exec(body)?.[0] ?? '';
    return text.slice(0, span.start) + rendered + (trailing || eol) + text.slice(span.end);
  }
  if (text.trim() === '') return rendered + eol;
  const base = text.endsWith('\n') ? text : text + eol;
  return `${base}${eol}${rendered}${eol}`;
}

/** Text with the table at `path` removed, the inverse of setTable's append. */
export function removeTable(text: string, path: string[]): string {
  const span = findTable(text, path);
  if (!span) return text;
  let before = text.slice(0, span.start);
  const after = text.slice(span.end);
  if (after === '') before = before.replace(/(\r?\n)\r?\n$/, '$1');
  return before + after;
}
