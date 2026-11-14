/** BCP-47 helpers. Intl.DisplayNames exists on Node, Workers and browsers. */

const primary = (code: string): string => code.toLowerCase().split(/[-_]/)[0] ?? '';
const rest = (code: string): string => code.toLowerCase().split(/[-_]/).slice(1).join('-');

/**
 * True when text in `have` satisfies a request for `want`: same primary
 * subtag, and when `want` names a script or region, `have` must not name a
 * different one (zh-Hant is not zh-Hans; pt satisfies pt-BR only when it says
 * nothing else).
 */
export function sameLanguage(have: string | undefined, want: string): boolean {
  if (!have) return false;
  if (primary(have) !== primary(want)) return false;
  const w = rest(want);
  const h = rest(have);
  return !w || !h || w === h;
}

/** "de" -> "German", "pt-BR" -> "Brazilian Portuguese"; the code itself when unknown. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/** Reject inputs that are not BCP-47 shaped before they reach a prompt or a URL. */
export function isLanguageTag(code: string): boolean {
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(code);
}
