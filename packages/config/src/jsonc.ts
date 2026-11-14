/**
 * JSON with comments and trailing commas. Comments and trailing commas are
 * blanked out with spaces (newlines kept), so JSON.parse error positions still
 * point at the right line and column of the original text.
 */

export class JsoncError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = 'JsoncError';
  }
}

function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/** Replace comments and trailing commas with whitespace of the same length. */
export function stripJsonc(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  };
  let i = 0;
  let lastComma = -1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      lastComma = -1;
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        const { line, column } = lineCol(text, i);
        throw new JsoncError(`unterminated block comment at line ${line} column ${column}`, line, column);
      }
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    if (c === ',') {
      lastComma = i;
    } else if (c === '}' || c === ']') {
      if (lastComma !== -1) out[lastComma] = ' ';
      lastComma = -1;
    } else if (c !== undefined && !/\s/.test(c)) {
      lastComma = -1;
    }
    i++;
  }
  return out.join('');
}

/** Parse JSONC text. Throws JsoncError with line and column when it can tell them. */
export function parseJsonc(text: string): unknown {
  const body = stripJsonc(text.replace(/^\uFEFF/, ''));
  try {
    return JSON.parse(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lc = /line (\d+) column (\d+)/.exec(msg);
    if (lc) {
      const line = Number(lc[1]);
      const column = Number(lc[2]);
      return failAt(msg, line, column);
    }
    const pos = /position (\d+)/.exec(msg);
    if (pos) {
      const { line, column } = lineCol(body, Number(pos[1]));
      return failAt(msg, line, column);
    }
    throw new JsoncError(msg);
  }
}

function failAt(msg: string, line: number, column: number): never {
  const clean = msg.replace(/\s*(in JSON )?at position \d+.*$/, '').replace(/\s*\(line \d+ column \d+\)/, '');
  throw new JsoncError(`${clean} at line ${line} column ${column}`, line, column);
}
