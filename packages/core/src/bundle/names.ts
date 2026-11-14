/**
 * Safe file and folder names for the bundle. Titles come from the internet,
 * so they can hold path separators, "..", control characters, emoji or
 * reserved Windows names. Every name the bundle writes goes through here.
 */

const MAX_SLUG = 60;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function rawSlug(input: string, max: number): string {
  let s = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > max) {
    const cut = s.slice(0, max);
    const lastHyphen = cut.lastIndexOf('-');
    s = (lastHyphen >= max / 2 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '');
  }
  return s;
}

function unreserve(s: string): string {
  return RESERVED.test(s) ? `${s}-video` : s;
}

/**
 * Lowercase slug: a to z, 0 to 9 and single hyphens, at most 60 characters,
 * cut at a word boundary when that keeps at least half the length. Accents
 * are folded. Uses `fallback` (slugged too) when nothing is left, for
 * example for a title written only in a non-Latin script.
 */
export function slugify(input: string, fallback = 'video', max = MAX_SLUG): string {
  return unreserve(rawSlug(input, max) || rawSlug(fallback, max) || 'video');
}

/**
 * A safe single path segment for a file name such as "transcript.srt": each
 * dot-separated part is slugged, so separators, "..", and control characters
 * cannot survive.
 */
export function safeFileName(name: string): string {
  const parts = name
    .split('.')
    .map((p) => rawSlug(p, MAX_SLUG))
    .filter(Boolean);
  if (!parts.length) return 'file';
  parts[0] = unreserve(parts[0] as string);
  return parts.join('.');
}

/**
 * Hands out unique names: the first "x" stays "x", then "x-2", "x-3". For
 * file names the suffix goes before the extension ("notes-2.md").
 */
export class UniqueNames {
  private readonly used = new Set<string>();

  /** `max` caps the whole name, suffix included, by trimming the base. */
  take(name: string, max = Number.POSITIVE_INFINITY): string {
    if (!this.used.has(name)) {
      this.used.add(name);
      return name;
    }
    const dot = name.indexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const room = Math.max(1, max - suffix.length - ext.length);
      const candidate = `${base.slice(0, room).replace(/-+$/, '')}${suffix}${ext}`;
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
  }
}
