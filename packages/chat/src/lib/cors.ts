/**
 * Which LLM services a web page may call directly, for client-only mode.
 *
 * Hosted services: measured on 2026-11-14 from a real Chromium 158 page on a
 * local origin by scripts/cors-probe.mjs, sending each the request its
 * provider really sends (result: test/fixtures/cors-probe.json). Services
 * not in the table were never checked, so client-only mode does not offer
 * them. Servers on this machine (the local tier) answer browser requests only
 * when configured to, so they stay available with a hint. Rungs that run
 * inside the page (WebGPU, Chrome built-in AI) need no network at all.
 */
import type { Tier } from '@vid2context/core';

export type CorsStatus = 'allowed' | 'blocked' | 'needs-config';

export interface BrowserCors {
  status: CorsStatus;
  /** Shown on disabled rows, and as a hint on local rows. */
  reason?: string;
}

const MEASURED: Record<string, CorsStatus> = {
  groq: 'allowed',
  mistral: 'allowed',
  gemini: 'allowed',
  'gemini-native': 'allowed',
  ovh: 'allowed',
  pollinations: 'allowed',
  openai: 'allowed',
  siliconflow: 'allowed',
  openrouter: 'allowed',
  'vertex-gemini': 'allowed',
  'vertex-anthropic': 'allowed',
  cerebras: 'blocked',
  github: 'blocked',
  kilo: 'blocked',
  nvidia: 'blocked',
  sambanova: 'blocked',
  cloudflare: 'blocked',
  zhipu: 'blocked',
  anthropic: 'blocked',
};

const LOCAL_NOTES: Record<string, string> = {
  ollama: 'Ollama answers web pages only from origins in OLLAMA_ORIGINS; add this page’s origin.',
  lmstudio: 'Turn on "Enable CORS" in LM Studio’s server settings.',
};
const LOCAL_DEFAULT_NOTE = 'Your local server must allow this page’s origin (CORS).';

/** Services that exist only inside a Cloudflare Worker. */
const WORKER_ONLY = new Set(['cloudflare-binding']);

/** Providers whose rungs run inside the page itself and need no network. */
const IN_BROWSER_PROVIDERS = new Set(['llm-browser']);

export function browserCorsFor(service: string, provider?: string, tier?: Tier): BrowserCors {
  if (provider && IN_BROWSER_PROVIDERS.has(provider)) return { status: 'allowed' };
  const base = service.replace(/#\d+$/, '');
  if (WORKER_ONLY.has(base)) return { status: 'blocked', reason: 'Runs only inside a Cloudflare Worker.' };
  const measured = MEASURED[base];
  if (measured === 'allowed') return { status: 'allowed' };
  if (measured === 'blocked') return { status: 'blocked', reason: 'Its API blocks requests from web pages (CORS). Use server mode.' };
  if (tier === 'local' || LOCAL_NOTES[base]) return { status: 'needs-config', reason: LOCAL_NOTES[base] ?? LOCAL_DEFAULT_NOTE };
  return { status: 'blocked', reason: 'Not checked for browser access yet. Use server mode.' };
}

/** The measured table, for docs and tests. */
export const MEASURED_CORS: Readonly<Record<string, CorsStatus>> = MEASURED;
