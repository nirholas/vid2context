/**
 * secrets: common credential shapes in tracked files. Documented format
 * samples go in secrets-allowlist.txt as `<path> <exact match>` lines.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, findAll, isMain, ROOT } from './lib.mjs';

export const PATTERNS = [
  ['Anthropic key', /(?<![\w-])sk-ant-[A-Za-z0-9_-]{16,}/g],
  ['OpenAI-style key', /(?<![\w-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g],
  ['Groq key', /(?<![\w-])gsk_[A-Za-z0-9]{20,}/g],
  ['Google API key', /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/g],
  ['GitHub token', /(?<![\w-])gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['GitHub fine-grained token', /(?<![\w-])github_pat_[A-Za-z0-9_]{20,}/g],
  ['Hugging Face token', /(?<![\w-])hf_[A-Za-z0-9]{30,}/g],
  ['AWS access key id', /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g],
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
];

export const ALLOWLIST_FILE = 'tooling/checks/secrets-allowlist.txt';

/** Parses the allowlist: `<path> <exact match>` per line, `#` starts a comment. */
export function parseAllowlist(text) {
  const allowed = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const [path, value] = line.split(/\s+/, 2);
    if (path && value) allowed.add(`${path} ${value}`);
  }
  return allowed;
}

const allowlist = parseAllowlist(readFileSync(join(ROOT, ALLOWLIST_FILE), 'utf8'));

export const name = 'secrets';
export const description = 'no API keys, tokens or private keys';

export function select(path) {
  return path !== ALLOWLIST_FILE;
}

export function check(path, text, allowed = allowlist) {
  const out = [];
  for (const [label, regex] of PATTERNS) {
    for (const h of findAll(text, regex)) {
      if (allowed.has(`${path} ${h.match}`)) continue;
      const shown = h.match.startsWith('-----') ? h.match : `${h.match.slice(0, 8)}...`;
      out.push({
        line: h.line,
        column: h.column,
        message: `${label} (${shown}): remove and rotate it, or allowlist a documented sample`,
      });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

if (isMain(import.meta.url)) process.exitCode = cli([{ name, description, select, check }]);
