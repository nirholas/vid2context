/**
 * What a recorded response must never carry before it is committed: email
 * addresses, stream URLs that embed the client's IP, and API keys. Used by
 * scripts/record-runnables.ts (refuses to write) and the tests (fail).
 */
const PRIVATE: { what: string; re: RegExp }[] = [
  { what: 'an email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}(?:\.[A-Za-z]{2,})*/g },
  { what: 'a stream URL with the client IP', re: /[?&]ip=\d/g },
  { what: 'an API key header', re: /Bearer\s+[A-Za-z0-9_-]{12,}/g },
];

/** The noreply identity is the only address allowed in this repo. */
const ALLOWED_EMAIL = /^(?:noreply@anthropic\.com|[A-Za-z0-9._%+-]+@users\.noreply\.github\.com)$/;

/** A description of the first private detail in `text`, or null. */
export function privacyProblem(text: string): string | null {
  for (const p of PRIVATE) {
    for (const m of text.matchAll(p.re)) {
      if (p.what === 'an email address' && ALLOWED_EMAIL.test(m[0])) continue;
      return `${p.what} (${m[0].slice(0, 40)})`;
    }
  }
  return null;
}
