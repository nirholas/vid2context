/**
 * "Copy transcript (via API)": `GET <apiBase>/transcript?url=`, with the
 * API's own error body (`{ error: { code, message, hint } }`) turned into a
 * Vid2ContextError so the hint reaches the user unchanged.
 */
import { type ErrorCode, Vid2ContextError } from '@vid2context/core';
import { apiTranscriptLink } from './links.ts';
import { AGENT_FORMAT, type Settings } from './settings.ts';

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'unsupported-input',
  'not-found',
  'unavailable',
  'no-transcript',
  'no-provider',
  'all-rungs-failed',
  'rate-limited',
  'auth',
  'blocked',
  'too-large',
  'timeout',
  'upstream',
  'bad-request',
]);

/** The server has no agent prompt route; `pack` is the closest format it renders. */
export function apiFormat(copyFormat: string): string {
  return copyFormat === AGENT_FORMAT ? 'pack' : copyFormat;
}

/** Turn an API error response into a Vid2ContextError, keeping its code and hint. */
export async function apiError(res: Response, apiBase: string): Promise<Vid2ContextError> {
  let body: { error?: { code?: string; message?: string; hint?: string } } | undefined;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = undefined;
  }
  const e = body?.error;
  if (e?.message) {
    const code = (e.code && CODES.has(e.code) ? e.code : 'upstream') as ErrorCode;
    return new Vid2ContextError(code, e.message, { status: res.status, ...(e.hint ? { hint: e.hint } : {}) });
  }
  return new Vid2ContextError('upstream', `The vid2context API at ${apiBase} answered HTTP ${res.status}.`, {
    status: res.status,
    hint: 'Check that the API base in the extension options points at a vid2context server (it ends in /api/v1).',
  });
}

export async function transcriptViaApi(
  input: string,
  settings: Pick<Settings, 'apiBase' | 'copyFormat' | 'timestamps'>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const url = apiTranscriptLink(settings.apiBase, input, apiFormat(settings.copyFormat), settings.timestamps);
  let res: Response;
  try {
    res = await fetchFn(url, { signal });
  } catch (err) {
    throw new Vid2ContextError('upstream', `Could not reach the vid2context API at ${settings.apiBase}.`, {
      cause: err,
      hint: 'Start a local server with "npm run dev:server", or set the API base in the extension options.',
    });
  }
  if (!res.ok) throw await apiError(res, settings.apiBase);
  return res.text();
}

/** A user-facing message and hint for any error. */
export function describeError(err: unknown): { message: string; hint?: string } {
  if (err instanceof Vid2ContextError) return { message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    const hint = 'hint' in err && typeof err.hint === 'string' ? err.hint : undefined;
    return { message: err.message, ...(hint ? { hint } : {}) };
  }
  return { message: String(err) };
}
