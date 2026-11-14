/**
 * Terms the translation must keep exactly as written: names, products, model
 * codes. The caller's list comes first, then the channel name, then
 * capitalized terms found in the title and description that repeat (or look
 * like codes: G-Wagon, GPT-4o, W463).
 *
 * Title-case titles capitalize every word, so a word only counts as a name
 * when the description also capitalizes it in the middle of a sentence, or
 * when its shape (a digit, an inner capital, a capitalized hyphen part) marks
 * it as a code or brand.
 */
import type { VideoMetadata } from '@vid2context/core';

export const MAX_GLOSSARY_TERMS = 30;

const COMMON = new Set(
  `a an and are as at be best but by can do for from free get has have how i if in is it its me my new no not of on or our
  so that the their them then there these this to top us vs was watch we what when where which who why will with you your
  part video videos channel subscribe link links description playlist series guide review episode full official live
  thanks thank contact follow click here today now more all one two`
    .split(/\s+/)
    .filter(Boolean),
);

/** Capitalized word runs ("Alliance Auto Care", "G-Wagon"), with whether each starts a sentence. */
function capitalizedRuns(text: string): { term: string; sentenceStart: boolean }[] {
  const out: { term: string; sentenceStart: boolean }[] = [];
  const word = String.raw`[\p{Lu}][\p{L}\p{N}]*(?:[-'’][\p{L}\p{N}]+)*|[\p{N}]+[\p{L}][\p{L}\p{N}]*`;
  const re = new RegExp(`(${word})(?:[ ](?:${word}))*`, 'gu');
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index).trimEnd();
    const sentenceStart = before === '' || /[.!?:;\n#@]$/.test(before) || /\n\s*$/.test(text.slice(0, m.index));
    out.push({ term: m[0].replace(/['’]s$/u, ''), sentenceStart });
  }
  return out;
}

const looksLikeCode = (t: string): boolean => /\p{N}/u.test(t) || /\p{Ll}\p{Lu}/u.test(t) || /\p{Lu}[-]\p{Lu}/u.test(t);

function clean(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@]\w+/g, ' ')
    .replace(/\[[^\]]*redacted\]/gi, ' ');
}

/** Normalize for counting: lowercase, hyphens and spaces equal ("G-Wagon" = "G Wagon"). */
const key = (t: string): string => t.toLowerCase().replace(/[-\s]+/g, ' ');

/** Drop leading common words so "FREE G-Wagon" and "Watch G-Wagon" count as "G-Wagon". */
function trimCommon(term: string): string {
  const words = term.split(' ');
  while (words.length > 1 && COMMON.has((words[0] ?? '').toLowerCase())) words.shift();
  return words.join(' ');
}

/** Every run of 1 to 3 words: a title-case title glues unrelated words into one run. */
function subRuns(term: string): string[] {
  const words = term.split(' ');
  const out: string[] = [];
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '));
  return out;
}

function usable(t: string): boolean {
  if (t.length < 2 || COMMON.has(t.toLowerCase()) || /^\p{N}+$/u.test(t)) return false;
  // Shouted words ("CONTACT", "FREE") are emphasis, not names, unless they look like a code.
  return !(t === t.toUpperCase() && t.length > 4 && !looksLikeCode(t));
}

/** Glossary terms from metadata, without the caller's own terms. */
export function metadataTerms(metadata: VideoMetadata): string[] {
  const title = clean(metadata.title ?? '');
  const desc = clean(metadata.description ?? '');
  const count = new Map<string, number>();
  const forms = new Map<string, string>();
  const midSentence = new Set<string>();
  for (const [text, isTitle] of [
    [title, true],
    [desc, false],
  ] as const) {
    for (const { term, sentenceStart } of capitalizedRuns(text)) {
      for (const t of isTitle ? subRuns(term) : [trimCommon(term)]) {
        if (!usable(t)) continue;
        const k = key(t);
        count.set(k, (count.get(k) ?? 0) + 1);
        if (!forms.has(k) || isTitle) forms.set(k, t);
        if (!isTitle && !sentenceStart) midSentence.add(k);
      }
    }
  }
  const keep: string[] = [];
  for (const [k, n] of count) {
    const form = forms.get(k) ?? k;
    if (n >= 2 && (midSentence.has(k) || looksLikeCode(form))) keep.push(form);
  }
  return keep;
}

/** The full glossary: caller terms, the channel name, then metadata terms, deduplicated, at most 30. */
export function buildGlossary(metadata: VideoMetadata, terms: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...terms, metadata.channel?.name ?? '', ...metadataTerms(metadata)]) {
    const v = t.trim();
    if (!v || seen.has(key(v))) continue;
    seen.add(key(v));
    out.push(v);
  }
  return out.slice(0, MAX_GLOSSARY_TERMS);
}
