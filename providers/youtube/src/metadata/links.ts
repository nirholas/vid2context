/** Every http(s) URL in a description, de-duplicated, in order of first appearance. */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/giu;
/** Punctuation that ends a sentence rather than the URL. */
const TRAILING = /[.,;:!?'"’”]+$/u;

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  // Drop a closing bracket the URL did not open: "(see https://x.com/a)".
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
  ] as const) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) url = url.slice(0, -1).replace(TRAILING, '');
  }
  return url;
}

export function extractLinks(description: string | undefined): string[] {
  if (!description) return [];
  const seen = new Set<string>();
  for (const m of description.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length > 'https://'.length) seen.add(url);
  }
  return [...seen];
}
