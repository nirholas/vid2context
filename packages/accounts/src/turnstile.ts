/**
 * Cloudflare Turnstile server-side validation, as documented at
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 * (checked 2026-11-14): POST the secret, the widget token and optionally the
 * visitor IP to siteverify; the answer is JSON with `success` and `error-codes`.
 * Tokens are at most 2048 characters, valid for 300 seconds and single use.
 */
import { type Ctx, fetchWithTimeout } from '@vid2context/core';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Request headers that may carry the widget token. */
export const TURNSTILE_HEADERS = ['x-turnstile-token', 'cf-turnstile-response'] as const;
export const TURNSTILE_MAX_TOKEN = 2048;

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
  hostname?: string;
  action?: string;
  challengeTs?: string;
}

/** Validate a Turnstile token. Never throws for a rejected token; network failures count as a failed check. */
export async function verifyTurnstile(
  ctx: Ctx,
  opts: { secret: string; token: string | undefined; remoteIp?: string },
): Promise<TurnstileResult> {
  const token = opts.token?.trim();
  if (!token) return { success: false, errorCodes: ['missing-input-response'] };
  if (token.length > TURNSTILE_MAX_TOKEN) return { success: false, errorCodes: ['invalid-input-response'] };
  const body = new URLSearchParams({ secret: opts.secret, response: token });
  if (opts.remoteIp) body.set('remoteip', opts.remoteIp);
  body.set('idempotency_key', crypto.randomUUID());
  let res: Response;
  try {
    res = await fetchWithTimeout(
      ctx,
      TURNSTILE_VERIFY_URL,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      10_000,
    );
  } catch (err) {
    ctx.log.warn('turnstile siteverify failed', { message: (err as Error).message });
    return { success: false, errorCodes: ['internal-error'] };
  }
  const data = (await res.json().catch(() => null)) as {
    success?: unknown;
    'error-codes'?: unknown;
    hostname?: unknown;
    action?: unknown;
    challenge_ts?: unknown;
  } | null;
  if (!res.ok || !data) return { success: false, errorCodes: ['internal-error'] };
  const errorCodes = Array.isArray(data['error-codes']) ? data['error-codes'].filter((c) => typeof c === 'string') : [];
  const out: TurnstileResult = { success: data.success === true, errorCodes };
  if (typeof data.hostname === 'string') out.hostname = data.hostname;
  if (typeof data.action === 'string' && data.action) out.action = data.action;
  if (typeof data.challenge_ts === 'string') out.challengeTs = data.challenge_ts;
  return out;
}

/** The widget token from the request headers, if any. */
export function turnstileToken(headers: Headers): string | undefined {
  for (const h of TURNSTILE_HEADERS) {
    const v = headers.get(h);
    if (v) return v;
  }
  return undefined;
}
