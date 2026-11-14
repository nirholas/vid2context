/**
 * New-item notifications. After a refresh adds videos, the library POSTs
 *
 *   { collection: { id, name }, added: VideoSummary[], checkedAt }
 *
 * to VID2CONTEXT_WEBHOOK_URL with
 *
 *   X-Vid2context-Signature: sha256=<hex HMAC-SHA256 of the raw body under VID2CONTEXT_WEBHOOK_SECRET>
 *   X-Vid2context-Timestamp: <unix seconds when this attempt was sent>
 *
 * 5xx, 429 and network errors are retried with exponential backoff. Delivery
 * never throws: failures are logged and reported in the returned result.
 * WebCrypto only, so it runs on Node, Workers and in the browser.
 */
import type { Collection, Ctx, VideoSummary } from '@vid2context/core';
import { sleep } from './util.ts';

export const SIGNATURE_HEADER = 'X-Vid2context-Signature';
export const TIMESTAMP_HEADER = 'X-Vid2context-Timestamp';

export interface WebhookPayload {
  collection: { id: string; name: string };
  added: VideoSummary[];
  checkedAt: string;
}

export interface WebhookOptions {
  /** Total attempts, first included. Default 4. */
  attempts?: number;
  /** Delay before the first retry; doubles each time. Default 1000 ms. */
  baseDelayMs?: number;
  /** Per-attempt timeout. Default 10 s. */
  timeoutMs?: number;
}

export interface WebhookResult {
  delivered: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sha256=<hex>`: the HMAC-SHA256 of `body` under `secret`, as sent in the signature header. */
export async function signBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))}`;
}

/** Constant-time check of a signature header against the body, for receivers written in JS. */
export async function verifySignature(body: string, secret: string, header: string | null | undefined): Promise<boolean> {
  if (!header) return false;
  const expected = await signBody(body, secret);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export function webhookPayload(collection: Collection, added: VideoSummary[], checkedAt: string): WebhookPayload {
  return { collection: { id: collection.id, name: collection.name }, added, checkedAt };
}

/** POST the payload to `url`, signing it when `secret` is set. Never throws. */
export async function sendWebhook(
  url: string,
  secret: string | undefined,
  payload: WebhookPayload,
  ctx: Ctx,
  opts: WebhookOptions = {},
): Promise<WebhookResult> {
  const total = Math.max(1, opts.attempts ?? 4);
  const base = opts.baseDelayMs ?? 1000;
  const body = JSON.stringify(payload);
  const signature = secret ? await signBody(body, secret) : undefined;
  if (!secret)
    ctx.log.warn('webhook sent unsigned: VID2CONTEXT_WEBHOOK_SECRET is not set', { collection: payload.collection.id });
  let last: WebhookResult = { delivered: false, attempts: 0 };
  for (let attempt = 1; attempt <= total; attempt++) {
    if (attempt > 1) await sleep(base * 2 ** (attempt - 2), ctx.signal);
    if (ctx.signal?.aborted) break;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    try {
      const res = await ctx.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'vid2context-webhook',
          [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
          ...(signature ? { [SIGNATURE_HEADER]: signature } : {}),
        },
        body,
        signal,
      });
      await res.body?.cancel();
      last = { delivered: res.ok, attempts: attempt, status: res.status };
      if (res.ok) return last;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = { delivered: false, attempts: attempt, error: err instanceof Error ? err.message : String(err) };
    }
  }
  ctx.log.warn('webhook delivery failed', {
    collection: payload.collection.id,
    attempts: last.attempts,
    status: last.status,
    error: last.error,
  });
  return last;
}
