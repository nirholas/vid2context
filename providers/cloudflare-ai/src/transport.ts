/**
 * Two ways to run a Workers AI model:
 *
 *   binding  inside a Worker, through the `AI` binding (env.AI.run). No token,
 *            no extra round trip. The binding is read from ctx.bindings at call time.
 *   rest     anywhere, through POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/<model>
 *            with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
 *
 * Both return the model's `result` object (the binding returns it directly;
 * REST wraps it in { result, success, errors, messages }). Cloudflare error
 * codes are mapped to Vid2ContextError codes with recovery hints.
 */
import { type Ctx, type ErrorCode, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';

/** The part of the Workers AI binding this provider uses. */
export interface AiBinding {
  run(model: string, inputs: unknown, options?: Record<string, unknown>): Promise<unknown>;
}

export type Transport =
  | { kind: 'binding'; binding: string }
  | { kind: 'rest'; accountId: string; token: string; baseUrl: string };

export const REST_BASE_URL = 'https://api.cloudflare.com/client/v4';

/** What to send: a JSON body, or raw bytes with a content type (legacy whisper over REST). */
export type RunInput = { json: Record<string, unknown> } | { bytes: Uint8Array; contentType: string; json: Record<string, unknown> };

interface CfError {
  code?: number;
  message?: string;
}

/** Seconds until the daily neuron allocation resets (00:00 UTC). */
export function secondsUntilUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

const MODELS_HINT = 'Check the model id against https://developers.cloudflare.com/workers-ai/models/ and fix CLOUDFLARE_STT_MODEL, CLOUDFLARE_EMBED_MODEL or CLOUDFLARE_BINDING_MODEL.';

/** Map a Workers AI error code (https://developers.cloudflare.com/workers-ai/platform/errors/) to our taxonomy. */
export function mapCloudflareCode(
  code: number,
): { code: ErrorCode; hint?: string; retryAfterSec?: number } | null {
  switch (code) {
    case 3036:
      return {
        code: 'rate-limited',
        hint: 'The daily free Workers AI allocation (10,000 neurons) is used up. It resets at 00:00 UTC; other rungs are tried meanwhile.',
        retryAfterSec: secondsUntilUtcMidnight(),
      };
    case 3040:
      return { code: 'rate-limited', hint: 'Workers AI is out of capacity for this model right now; retry in a minute.', retryAfterSec: 60 };
    case 7000:
    case 5007:
    case 3042:
      return { code: 'not-found', hint: MODELS_HINT };
    case 5028:
      return { code: 'not-found', hint: `This model was retired. ${MODELS_HINT}` };
    case 10000:
      return {
        code: 'auth',
        hint: 'Cloudflare rejected the token. Create an API token with the Workers AI permission and set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.',
      };
    case 5035:
      return { code: 'auth', hint: 'This model needs the Workers Paid plan. Pick a model without that requirement.' };
    case 5016:
      return { code: 'auth', hint: 'Accept the model license once by sending the prompt "agree" to this model, then retry.' };
    case 5018:
    case 3041:
      return { code: 'auth', hint: 'This account cannot use that model. Pick a public model.' };
    case 3023:
      return { code: 'auth', hint: 'Workers AI is blocked for this account; check the Cloudflare dashboard.' };
    case 3006:
      return { code: 'too-large', hint: 'The request is larger than Workers AI accepts; split the audio or send less text.' };
    case 3007:
    case 3008:
      return { code: 'timeout', hint: 'Workers AI timed out; retry or use a shorter input.' };
    case 3030:
      return { code: 'upstream', hint: 'Workers AI could not decode the input. Convert the audio to mp3, wav or flac.' };
    default:
      return null;
  }
}

function fromCode(label: string, err: CfError, status?: number): Vid2ContextError | null {
  if (typeof err.code !== 'number') return null;
  const mapped = mapCloudflareCode(err.code);
  if (!mapped) return null;
  return new Vid2ContextError(mapped.code, `${label}: ${err.code} ${err.message ?? ''}`.trim(), {
    hint: mapped.hint,
    status,
    retryAfterSec: mapped.retryAfterSec,
  });
}

/** Errors thrown by env.AI.run carry the code in the message, e.g. "3036: ..." or "AiError: ... (3030)". */
export function errorFromBinding(label: string, err: unknown): Vid2ContextError {
  if (err instanceof Vid2ContextError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const m = /(?:^|\D)([35]\d{3}|7000|10000)(?::|\)|$)/.exec(message);
  const mapped = m ? fromCode(label, { code: Number(m[1]), message }) : null;
  return mapped ?? new Vid2ContextError('upstream', `${label}: ${message}`, { cause: err });
}

export function getAiBinding(ctx: Ctx, name: string): AiBinding {
  const b = ctx.bindings?.[name] as Partial<AiBinding> | undefined;
  if (!b || typeof b.run !== 'function') {
    throw new Vid2ContextError('no-provider', `Workers AI binding "${name}" is not available in this runtime.`, {
      hint: `Add "ai": { "binding": "${name}" } to wrangler.jsonc, or unset CLOUDFLARE_AI_BINDING outside a Worker.`,
    });
  }
  return b as AiBinding;
}

async function runRest(ctx: Ctx, t: Extract<Transport, { kind: 'rest' }>, model: string, input: RunInput, label: string, timeoutMs: number) {
  const url = `${t.baseUrl}/accounts/${encodeURIComponent(t.accountId)}/ai/run/${model}`;
  const raw = 'bytes' in input;
  const res = await fetchWithTimeout(
    ctx,
    url,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': raw ? input.contentType : 'application/json' },
      body: raw ? input.bytes.slice() : JSON.stringify(input.json),
    },
    timeoutMs,
  );
  return { res, url };
}

async function envelopeError(res: Response, label: string): Promise<Vid2ContextError> {
  const text = await res
    .clone()
    .text()
    .catch(() => '');
  try {
    const body = JSON.parse(text) as { errors?: CfError[] };
    for (const e of body.errors ?? []) {
      const mapped = fromCode(label, e, res.status);
      if (mapped) return mapped;
    }
  } catch {
    // Not JSON: fall through to the status mapping.
  }
  return errorFromResponse(res, label);
}

/** Run a model and return its `result`. */
export async function runModel(
  ctx: Ctx,
  t: Transport,
  model: string,
  input: RunInput,
  opts: { label: string; timeoutMs?: number; bindingInput?: unknown },
): Promise<unknown> {
  if (t.kind === 'binding') {
    const ai = getAiBinding(ctx, t.binding);
    try {
      return await ai.run(model, opts.bindingInput ?? input.json);
    } catch (err) {
      throw errorFromBinding(opts.label, err);
    }
  }
  const { res } = await runRest(ctx, t, model, input, opts.label, opts.timeoutMs ?? 120_000);
  if (!res.ok) throw await envelopeError(res, opts.label);
  const body = (await res.json()) as { success?: boolean; result?: unknown; errors?: CfError[] };
  if (body.success === false) {
    for (const e of body.errors ?? []) {
      const mapped = fromCode(opts.label, e, res.status);
      if (mapped) throw mapped;
    }
    throw new Vid2ContextError('upstream', `${opts.label}: ${JSON.stringify(body.errors ?? []).slice(0, 300)}`);
  }
  return body.result;
}

/** Run a model with stream: true and return the SSE byte stream. */
export async function runModelStream(
  ctx: Ctx,
  t: Transport,
  model: string,
  json: Record<string, unknown>,
  opts: { label: string; timeoutMs?: number },
): Promise<ReadableStream<Uint8Array>> {
  const body = { ...json, stream: true };
  if (t.kind === 'binding') {
    const ai = getAiBinding(ctx, t.binding);
    let out: unknown;
    try {
      out = await ai.run(model, body);
    } catch (err) {
      throw errorFromBinding(opts.label, err);
    }
    if (out instanceof ReadableStream) return out as ReadableStream<Uint8Array>;
    throw new Vid2ContextError('upstream', `${opts.label}: the binding did not return a stream.`);
  }
  const { res } = await runRest(ctx, t, model, { json: body }, opts.label, opts.timeoutMs ?? 300_000);
  if (!res.ok) throw await envelopeError(res, opts.label);
  if (!res.body) throw new Vid2ContextError('upstream', `${opts.label}: empty stream.`);
  return res.body;
}

/** Runtime-neutral base64 (no Buffer): Workers, Node and browsers all have btoa. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}
