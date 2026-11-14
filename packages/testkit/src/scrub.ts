/**
 * Secret and IP scrubbing for recorded fixtures. Always on: the recorder runs
 * every request and response through these functions before writing a file,
 * so a key never reaches disk even when a caller forgets to pass options.
 *
 * Kept local to the testkit on purpose: the runtime redactor in core is a
 * separate piece of work and the recorder must not depend on it.
 */

/** Marker written in place of a secret in headers and bodies. */
export const REDACTED = '[redacted]';
/** Marker written in place of a secret inside a URL (URL-safe, so it survives URL parsing). */
export const REDACTED_URL = 'REDACTED';

/** Request and response headers that carry credentials. Their values are always replaced. */
export const SECRET_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'x-goog-api-key', 'proxy-authorization'];

/** Query parameters that carry credentials. */
export const SECRET_PARAMS = ['key', 'api_key', 'apikey', 'token', 'access_token', 'refresh_token', 'client_secret'];

/** Query parameters in media stream URLs that embed the requesting machine's IP or a signature tied to it. */
export const STREAM_PARAMS = ['ip', 'ipbits', 'sig', 'lsig', 'signature', 'n'];

/** JSON field names treated as secrets wherever they appear in a body. */
const SECRET_FIELD =
  /^(api[_-]?key|apikey|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|password|passwd|authorization|bearer)$/i;

/** Env var names whose literal values are scrubbed from everything recorded. */
const SECRET_ENV = /_(KEY|KEYS|TOKEN|SECRET|PASSWORD)$/;

/** Shapes of well-known API keys. Order matters: sk-ant- before sk-. */
const KEY_SHAPES: { name: string; re: RegExp }[] = [
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{8,}/g },
  { name: 'groq-key', re: /\bgsk_[A-Za-z0-9]{8,}/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{20,}/g },
  { name: 'github-token', re: /\bghp_[A-Za-z0-9]{16,}/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{16,}/g },
  { name: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{16,}/g },
];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;

export interface ScrubOptions {
  /** Env to take literal secret values from (every `*_KEY`, `*_KEYS`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`). */
  env?: Record<string, string | undefined>;
  /** Extra literal values to scrub. */
  values?: string[];
}

export interface ScrubFinding {
  /** Where the secret was: 'request.url', 'request.headers', 'request.body', 'response.headers', 'response.body'. */
  where: string;
  /** What kind of secret: a header or param name, an env var name, a key shape, 'json-field:<name>'. */
  what: string;
  count: number;
}

export interface ScrubReport {
  findings: ScrubFinding[];
  /** Human warnings, e.g. a media stream URL that embedded an IP address. */
  warnings: string[];
}

/** Collects findings while scrubbing one exchange. */
export class Scrubber {
  readonly findings: ScrubFinding[] = [];
  readonly warnings: string[] = [];
  private readonly literals: { name: string; value: string }[];

  constructor(opts: ScrubOptions = {}) {
    const lits: { name: string; value: string }[] = [];
    for (const [name, raw] of Object.entries(opts.env ?? {})) {
      if (!raw || !SECRET_ENV.test(name)) continue;
      const parts = name.endsWith('_KEYS') ? raw.split(',') : [raw];
      for (const p of parts) {
        const v = p.trim();
        if (v.length >= 6) lits.push({ name, value: v });
      }
    }
    for (const v of opts.values ?? []) if (v && v.length >= 4) lits.push({ name: 'value', value: v });
    // Longest first so a value that contains another is replaced whole.
    this.literals = lits.sort((a, b) => b.value.length - a.value.length);
  }

  private note(where: string, what: string, count = 1): void {
    const found = this.findings.find((f) => f.where === where && f.what === what);
    if (found) found.count += count;
    else this.findings.push({ where, what, count });
  }

  private warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  /** Replace env literals and key shapes in any text. */
  text(input: string, where: string, marker = REDACTED): string {
    let out = input;
    for (const { name, value } of this.literals) {
      const variants = new Set([value, encodeURIComponent(value)]);
      for (const v of variants) {
        if (!out.includes(v)) continue;
        const parts = out.split(v);
        this.note(where, `env:${name}`, parts.length - 1);
        out = parts.join(marker);
      }
    }
    for (const { name, re } of KEY_SHAPES) {
      out = out.replace(re, () => {
        this.note(where, name);
        return marker;
      });
    }
    return this.streamUrlsInText(out, where);
  }

  /** Strip IP-bearing params from media stream URLs embedded in a body (JSON escapes `&` as &). */
  private streamUrlsInText(input: string, where: string): string {
    return input.replace(/https?:\/\/[^\s"'<>]*googlevideo\.com\/[^\s"'<>]*/g, (url) => {
      let changed = false;
      let out = url.replace(/([?&]|\\u0026|&amp;)([a-z_]+)=([^&"'\\\s]*)/gi, (m, sep: string, name: string, value: string) => {
        if (!STREAM_PARAMS.includes(name.toLowerCase()) && !isIp(decodeSafe(value))) return m;
        changed = true;
        return `${sep}${name}=${REDACTED_URL}`;
      });
      out = out.replace(/\/ip\/[^/]+/g, () => {
        changed = true;
        return `/ip/${REDACTED_URL}`;
      });
      if (changed) {
        this.note(where, 'stream-url-ip');
        this.warn(`A media stream URL in ${where} embedded an IP address or signature; it was scrubbed. Grep the fixture for your public IP before committing.`);
      }
      return out;
    });
  }

  url(input: string, where = 'request.url'): string {
    let u: URL;
    try {
      u = new URL(input);
    } catch {
      return this.text(input, where, REDACTED_URL);
    }
    const isStream = /(^|\.)googlevideo\.com$/i.test(u.hostname);
    for (const [name, value] of [...u.searchParams.entries()]) {
      const lower = name.toLowerCase();
      if (SECRET_PARAMS.includes(lower)) {
        u.searchParams.set(name, REDACTED_URL);
        this.note(where, `param:${lower}`);
      } else if ((isStream && STREAM_PARAMS.includes(lower)) || isIp(value)) {
        u.searchParams.set(name, REDACTED_URL);
        this.note(where, 'stream-url-ip');
        this.warn(`The request URL ${u.hostname}${u.pathname} carried "${name}" (an IP address or signature); it was scrubbed.`);
      }
    }
    if (isStream && /\/ip\/[^/]+/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/ip\/[^/]+/g, `/ip/${REDACTED_URL}`);
      this.note(where, 'stream-url-ip');
    }
    return this.text(u.href, where, REDACTED_URL);
  }

  headers(input: Record<string, string>, where: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      const lower = k.toLowerCase();
      if (SECRET_HEADERS.includes(lower)) {
        out[lower] = REDACTED;
        this.note(where, `header:${lower}`);
      } else {
        out[lower] = this.text(v, where);
      }
    }
    return out;
  }

  /** Scrub a text body: JSON fields named like secrets, then literal values and key shapes. */
  body(input: string, where: string): string {
    const trimmed = input.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(input) as unknown;
        let hits = 0;
        const walk = (v: unknown): unknown => {
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
              if (SECRET_FIELD.test(k) && (typeof val === 'string' || typeof val === 'number')) {
                hits++;
                this.note(where, `json-field:${k}`);
                o[k] = REDACTED;
              } else o[k] = walk(val);
            }
            return o;
          }
          return v;
        };
        const cleaned = walk(parsed);
        // Only re-serialise when a field changed, so untouched bodies stay byte-identical.
        if (hits > 0) return this.text(JSON.stringify(cleaned), where);
      } catch {
        // Not JSON after all; fall through to text scrubbing.
      }
    }
    return this.text(input, where);
  }

  report(): ScrubReport {
    return { findings: this.findings.map((f) => ({ ...f })), warnings: [...this.warnings] };
  }
}

function decodeSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function isIp(value: string): boolean {
  const m = IPV4.exec(value);
  if (m) return m.slice(1).every((p) => Number(p) <= 255);
  // IPv6: at least three colons and either a '::' or the full eight groups, so clock times like 12:30:00 are not mistaken for one.
  const colons = value.replace(/[^:]/g, '').length;
  return IPV6.test(value) && colons >= 3 && (value.includes('::') || colons === 7);
}

/** Merge several reports into one, summing counts. */
export function mergeReports(reports: ScrubReport[]): ScrubReport {
  const findings: ScrubFinding[] = [];
  const warnings: string[] = [];
  for (const r of reports) {
    for (const f of r.findings) {
      const found = findings.find((x) => x.where === f.where && x.what === f.what);
      if (found) found.count += f.count;
      else findings.push({ ...f });
    }
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
  }
  return { findings, warnings };
}
