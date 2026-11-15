/**
 * Serialize result JSON in the same layout Biome's JSON formatter produces
 * for this repo (2-space indent, line width 130), so a freshly written
 * `results/*.json` passes `npx biome check packages/evals` without a
 * separate formatting step.
 *
 * Biome's rules, as they apply to JSON that starts out expanded:
 * - a non-empty object always breaks onto one member per line;
 * - an array without objects in it collapses onto one line, `[a, b]`, when
 *   that line (indent, key and trailing comma included) fits the width;
 *   otherwise an array of numbers fills each line with as many numbers as
 *   fit, and any other array breaks with one element per line;
 * - empty objects and arrays print as `{}` and `[]`.
 */

export const JSON_LINE_WIDTH = 130;
const INDENT = '  ';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Display width: East Asian wide and fullwidth characters take two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function hasObject(value: Json): boolean {
  if (Array.isArray(value)) return value.some(hasObject);
  return value !== null && typeof value === 'object';
}

/** The single-line form of a value that contains no objects. */
function flat(value: Json): string {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.map(flat).join(', ')}]`;
  return JSON.stringify(value);
}

/**
 * @param prefix  text already on the line before the value (indent plus `"key": `)
 * @param suffix  text that follows the value on the same line (`,` or nothing)
 */
function format(value: Json, depth: number, prefix: string, suffix: string): string {
  const pad = INDENT.repeat(depth);
  const inner = INDENT.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (!hasObject(value)) {
      const line = flat(value);
      if (displayWidth(prefix) + displayWidth(line) + suffix.length <= JSON_LINE_WIDTH) return line;
    }
    if (value.every((v) => typeof v === 'number')) {
      const lines: string[] = [];
      let line = '';
      value.forEach((item, i) => {
        const piece = `${JSON.stringify(item)}${i < value.length - 1 ? ',' : ''}`;
        if (line && displayWidth(line) + 1 + displayWidth(piece) <= JSON_LINE_WIDTH) line += ` ${piece}`;
        else {
          if (line) lines.push(line);
          line = `${inner}${piece}`;
        }
      });
      lines.push(line);
      return `[\n${lines.join('\n')}\n${pad}]`;
    }
    const rows = value.map((item, i) => {
      const comma = i < value.length - 1 ? ',' : '';
      return `${inner}${format(item, depth + 1, inner, comma)}${comma}`;
    });
    return `[\n${rows.join('\n')}\n${pad}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const rows = entries.map(([key, item], i) => {
      const comma = i < entries.length - 1 ? ',' : '';
      const head = `${inner}${JSON.stringify(key)}: `;
      return `${head}${format(item, depth + 1, head, comma)}${comma}`;
    });
    return `{\n${rows.join('\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

/** Serialize `value` (anything JSON.stringify accepts) in Biome's layout, with a trailing newline. */
export function formatJson(value: unknown): string {
  // Round-trip first so toJSON, undefined members and non-finite numbers behave exactly as in JSON.stringify.
  const plain = JSON.parse(JSON.stringify(value)) as Json;
  return `${format(plain, 0, '', '')}\n`;
}
