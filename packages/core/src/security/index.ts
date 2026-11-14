/**
 * Shared security defenses: URL policy and SSRF-safe fetch, the public-mode
 * input policy, secret redaction, fencing untrusted text for LLMs, argument
 * and path safety, and central limits. Runtime-neutral (no `node:` imports).
 * See docs/security/hardening.md for how each package must use them.
 */
export { type FencedText, fenceUntrusted, UNTRUSTED_SYSTEM_PROMPT } from './fence.ts';
export { type SafeFetchOptions, type SafeFetchResult, safeFetch } from './fetch.ts';
export { checkInput, enforceInputPolicy, isPublicMode } from './input.ts';
export { blockedAddress, isIpLiteral, parseIPv4, parseIPv6 } from './ip.ts';
export { type Limits, limits } from './limits.ts';
export { assertSafeArg, safeFilename, safeJoin } from './paths.ts';
export { REDACTED, redact } from './redact.ts';
export {
  checkUrl,
  checkUrlSync,
  getHostResolver,
  type HostResolver,
  setHostResolver,
  type UrlCheck,
  type UrlPolicy,
} from './url.ts';
