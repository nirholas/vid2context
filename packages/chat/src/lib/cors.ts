/**
 * Which LLM services a web page may call directly, for client-only mode.
 *
 * Measured on 2026-11-14 from a real Chromium 158 page on a local origin by
 * scripts/cors-probe.mjs (result: test/fixtures/cors-probe.json). Services
 * not in the table were never checked, so client-only mode does not offer
 * them. Local servers on this machine answer browser requests only when
 * configured to (see the notes), so they stay available with that hint.
 */
export type CorsStatus = 'allowed' | 'blocked' | 'needs-config';

export interface BrowserCors {
  status: CorsStatus;
  /** Shown on disabled rows and next to local rows in the picker. */
  reason?: string;
}

const MEASURED: Record<string, CorsStatus> = {
  groq: 'allowed',
  mistral: 'allowed',
  gemini: 'allowed',
  ovh: 'allowed',
  pollinations: 'allowed',
  openai: 'allowed',
  cerebras: 'blocked',
  github: 'blocked',
};

const LOCAL_NOTES: Record<string, string> = {
  ollama: 'Ollama answers web pages only from origins listed in OLLAMA_ORIGINS; add this page.',
  lmstudio: 'Turn on "Enable CORS" in LM Studio’s server settings.',
  local: 'Your server must send Access-Control-Allow-Origin for this page.',
};

/** Providers whose rungs run inside the page itself (WebGPU, Chrome built-in AI) and need no network. */
const IN_BROWSER_PROVIDERS = new Set(['llm-browser']);

export function browserCorsFor(service: string, provider?: string): BrowserCors {
  if (provider && IN_BROWSER_PROVIDERS.has(provider)) return { status: 'allowed' };
  const base = service.replace(/#\d+$/, '');
  const note = LOCAL_NOTES[base];
  if (note) return { status: 'needs-config', reason: note };
  const measured = MEASURED[base];
  if (measured === 'allowed') return { status: 'allowed' };
  if (measured === 'blocked') return { status: 'blocked', reason: 'Its API blocks requests from web pages (CORS). Use server mode.' };
  return { status: 'blocked', reason: 'Not checked for browser access yet. Use server mode.' };
}

/** The measured table, for docs and the settings dialog. */
export const MEASURED_CORS: Readonly<Record<string, CorsStatus>> = MEASURED;
