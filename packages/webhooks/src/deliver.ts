/**
 * Delivery: sign, POST, classify the answer, retry with backoff, and disable
 * hooks that keep failing.
 *
 * - Success is any 2xx. Redirects are not followed (a 3xx is a failure, as
 *   the Standard Webhooks spec recommends, and following one could reach a
 *   host the URL guard never saw).
 * - Network errors, timeouts (10 s by default), 5xx and 429 are retried on
 *   the schedule below, plus jitter. A Retry-After longer than the next delay
 *   wins. Other 4xx answers are final for that message. 410 Gone disables the
 *   hook at once.
 * - Every failed attempt adds one to the hook's `failures`; a success resets
 *   it. At 20 consecutive failures the hook is disabled.
 * - Retries run through a RetryScheduler. The default one uses setTimeout in
 *   this process, so pending retries are lost on restart and, on Workers, end
 *   with the request; pass a durable scheduler (a job queue) to keep them.
 */
import { type Ctx, Vid2ContextError } from '@vid2context/core';
import type { AnyEventType, WebhookEventData, WebhookEventType, WebhookPayload } from './events.ts';
import { TEST_EVENT } from './events.ts';
import { generateMessageId, signedHeaders } from './signing.ts';
import type { WebhookRecord, WebhookStore } from './store.ts';
import { checkWebhookUrl, type UrlGuardOptions } from './url-guard.ts';

/** Delays before attempts 1 to 6: at once, 30 s, 5 min, 30 min, 2 h, 8 h. */
export const DEFAULT_RETRY_DELAYS_MS = [0, 30_000, 300_000, 1_800_000, 7_200_000, 28_800_000];
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_FAILURES = 20;
/** Payloads carry ids and links, so anything near this size is a bug in the emitter. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_RETRY_AFTER_MS = 24 * 3_600_000;
const USER_AGENT = 'vid2context-webhooks/0.1 (+https://www.standardwebhooks.com/)';

/** One pending delivery of one message to one hook. JSON-serialisable, so a durable queue can hold it. */
export interface DeliveryTask {
  hookId: string;
  messageId: string;
  type: AnyEventType;
  /** The exact body to send; it is signed again on every attempt with a fresh timestamp. */
  body: string;
  /** Zero-based index of the attempt to run. */
  attempt: number;
}

export interface AttemptResult {
  hookId: string;
  messageId: string;
  type: AnyEventType;
  /** One-based attempt number. */
  attempt: number;
  /**
   * delivered: 2xx. retrying: failed, another attempt is scheduled. failed:
   * failed with no attempts left or a final answer. disabled: this failure
   * disabled the hook. skipped: the hook was deleted or disabled before this
   * attempt ran.
   */
  outcome: 'delivered' | 'retrying' | 'failed' | 'disabled' | 'skipped';
  status?: number;
  error?: string;
  ms: number;
  /** Delay before the next attempt, when one is scheduled. */
  nextAttemptInMs?: number;
}

export interface RetryScheduler {
  /** Run `deliverTask(task, ...)` after about `delayMs`. */
  schedule(task: DeliveryTask, delayMs: number): void | Promise<void>;
}

export interface DeliveryOptions extends UrlGuardOptions {
  /** Delay before each attempt; its length is the attempt count. Default DEFAULT_RETRY_DELAYS_MS. */
  retryDelaysMs?: number[];
  /** Per-attempt timeout. Default 10 s. */
  timeoutMs?: number;
  /** Consecutive failed attempts that disable a hook. Default 20. */
  maxFailures?: number;
  /** Where retries wait. Default: setTimeout in this process. */
  scheduler?: RetryScheduler;
  /** Add up to +-20% random jitter to retry delays. Default true. */
  jitter?: boolean;
  /** Called after every attempt, including scheduled retries. */
  onAttempt?: (result: AttemptResult) => void;
}

export interface EmitResult {
  messageId: string;
  payload: WebhookPayload;
  /** The first attempt for every subscribed hook. Retries report through `onAttempt`. */
  deliveries: AttemptResult[];
}

function jittered(ms: number, on: boolean): number {
  if (ms <= 0 || !on) return Math.max(0, ms);
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}

/** Timers keep running for scheduled retries but must not hold a CLI process open. */
function timerScheduler(store: WebhookStore, ctx: Ctx, opts: DeliveryOptions): RetryScheduler {
  return {
    schedule(task, delayMs) {
      const timer = setTimeout(() => {
        deliverTask(task, store, ctx, opts).catch((err: unknown) => {
          ctx.log.error('webhook retry crashed', {
            hookId: task.hookId,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }, delayMs) as unknown as { unref?: () => void };
      timer.unref?.();
    },
  };
}

interface Classified {
  ok: boolean;
  retryable: boolean;
  status?: number;
  error?: string;
  disable?: string;
  retryAfter?: number;
}

async function send(record: WebhookRecord, task: DeliveryTask, ctx: Ctx, opts: DeliveryOptions): Promise<Classified> {
  try {
    await checkWebhookUrl(record.url, ctx, opts);
  } catch (err) {
    return { ok: false, retryable: false, error: err instanceof Error ? err.message : String(err) };
  }
  const headers = await signedHeaders(record.secret, task.messageId, Date.now() / 1000, task.body);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
  let res: Response;
  try {
    res = await ctx.fetch(record.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...headers },
      body: task.body,
      redirect: 'manual',
      signal,
    });
  } catch (err) {
    const timedOut = timeout.aborted;
    const message = timedOut
      ? `no answer within ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
      : err instanceof Error
        ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ''}`
        : String(err);
    return { ok: false, retryable: !ctx.signal?.aborted || timedOut, error: message };
  }
  // The body is never used; release the connection.
  await res.body?.cancel().catch(() => undefined);
  const s = res.status;
  if (s >= 200 && s < 300) return { ok: true, retryable: false, status: s };
  if (s === 410)
    return { ok: false, retryable: false, status: s, error: 'HTTP 410 Gone', disable: 'the receiver answered 410 Gone' };
  if (s === 429 || s >= 500) return { ok: false, retryable: true, status: s, error: `HTTP ${s}`, retryAfter: retryAfterMs(res) };
  if (s >= 300 && s < 400)
    return { ok: false, retryable: false, status: s, error: `HTTP ${s} redirect (not followed; update the webhook URL)` };
  return { ok: false, retryable: false, status: s, error: `HTTP ${s}` };
}

async function attempt(
  record: WebhookRecord,
  task: DeliveryTask,
  store: WebhookStore,
  ctx: Ctx,
  opts: DeliveryOptions,
  mode: { retries: boolean; reenable?: boolean },
): Promise<AttemptResult> {
  const started = Date.now();
  const r = await send(record, task, ctx, opts);
  const base = { hookId: record.id, messageId: task.messageId, type: task.type, attempt: task.attempt + 1, status: r.status };
  let result: AttemptResult;
  if (r.ok) {
    await store.recordSuccess(record.id, r.status ?? 200, { reenable: mode.reenable });
    result = { ...base, outcome: 'delivered', ms: Date.now() - started };
  } else {
    const updated = await store.recordFailure(
      record.id,
      { status: r.status, error: r.error ?? 'failed', disable: r.disable },
      opts.maxFailures ?? DEFAULT_MAX_FAILURES,
    );
    const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const nextDelay = delays[task.attempt + 1];
    const disabledNow = Boolean(updated?.disabledAt) && !record.disabledAt;
    const ms = Date.now() - started;
    if (disabledNow) {
      ctx.log.warn('webhook disabled', { hookId: record.id, reason: updated?.disabledReason });
      result = { ...base, outcome: 'disabled', error: r.error, ms };
    } else if (mode.retries && r.retryable && nextDelay !== undefined && !updated?.disabledAt) {
      const wait = Math.max(jittered(nextDelay, opts.jitter ?? true), r.retryAfter ?? 0);
      const scheduler = opts.scheduler ?? timerScheduler(store, { ...ctx, signal: undefined }, opts);
      await scheduler.schedule({ ...task, attempt: task.attempt + 1 }, wait);
      result = { ...base, outcome: 'retrying', error: r.error, ms, nextAttemptInMs: wait };
    } else {
      result = { ...base, outcome: 'failed', error: r.error, ms };
    }
  }
  ctx.log.info('webhook attempt', { ...result });
  opts.onAttempt?.(result);
  return result;
}

/**
 * Run one scheduled attempt. Durable schedulers (a job queue) call this when
 * a task comes due. A deleted or disabled hook is skipped.
 */
export async function deliverTask(
  task: DeliveryTask,
  store: WebhookStore,
  ctx: Ctx,
  opts: DeliveryOptions = {},
): Promise<AttemptResult> {
  const record = await store.get(task.hookId);
  if (!record || record.disabledAt) {
    const result: AttemptResult = {
      hookId: task.hookId,
      messageId: task.messageId,
      type: task.type,
      attempt: task.attempt + 1,
      outcome: 'skipped',
      error: record ? 'webhook is disabled' : 'webhook was deleted',
      ms: 0,
    };
    opts.onAttempt?.(result);
    return result;
  }
  return attempt(record, task, store, ctx, opts, { retries: true });
}

export interface EmitEvent<T extends WebhookEventType = WebhookEventType> {
  type: T;
  data: WebhookEventData[T];
  /** When the event happened. Default: now. */
  timestamp?: string;
}

function serialize(payload: WebhookPayload): string {
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > MAX_PAYLOAD_BYTES) {
    throw new Vid2ContextError('too-large', `Webhook payload for ${payload.type} is over ${MAX_PAYLOAD_BYTES} bytes.`, {
      hint: 'Webhook payloads carry ids, titles and links only; send links to the API instead of transcripts or results.',
    });
  }
  return body;
}

/**
 * Deliver an event to every enabled hook subscribed to its type. Resolves
 * after each hook's first attempt; failed attempts that can be retried are
 * scheduled and report through `opts.onAttempt`.
 */
export async function emit<T extends WebhookEventType>(
  event: EmitEvent<T>,
  store: WebhookStore,
  ctx: Ctx,
  opts: DeliveryOptions = {},
): Promise<EmitResult> {
  const payload = {
    type: event.type,
    timestamp: event.timestamp ?? new Date().toISOString(),
    data: event.data,
  } as WebhookPayload;
  const body = serialize(payload);
  const messageId = generateMessageId();
  const hooks = await store.subscribers(event.type);
  const deliveries = await Promise.all(
    hooks.map((record) =>
      attempt(record, { hookId: record.id, messageId, type: event.type, body, attempt: 0 }, store, ctx, opts, { retries: true }),
    ),
  );
  return { messageId, payload, deliveries };
}

/**
 * Send a `test.ping` to one hook: a single attempt with no retries, sent even
 * when the hook is disabled. A success re-enables a disabled hook, so this is
 * how a user recovers after fixing their receiver.
 */
export async function sendTestPing(
  id: string,
  store: WebhookStore,
  ctx: Ctx,
  opts: DeliveryOptions = {},
): Promise<AttemptResult> {
  const record = await store.get(id);
  if (!record) {
    throw new Vid2ContextError('not-found', `Webhook not found: ${id}`, {
      hint: 'GET /api/v1/webhooks lists the registered webhooks.',
    });
  }
  const payload: WebhookPayload<'test.ping'> = {
    type: TEST_EVENT,
    timestamp: new Date().toISOString(),
    data: { webhookId: record.id, message: 'Test ping from vid2context. Verify the signature, answer 2xx, and you are set.' },
  };
  const task: DeliveryTask = {
    hookId: record.id,
    messageId: generateMessageId(),
    type: TEST_EVENT,
    body: serialize(payload),
    attempt: 0,
  };
  return attempt(record, task, store, ctx, opts, { retries: false, reenable: true });
}

export interface WebhookEmitter {
  /**
   * Emit an event. Never throws: delivery problems are logged through
   * ctx.log, so a refresh, job or brief never fails because a receiver did.
   * Resolves to null when emitting itself failed.
   */
  on<T extends WebhookEventType>(type: T, data: WebhookEventData[T]): Promise<EmitResult | null>;
}

/** The hook point for item 41 (library), 42 (jobs) and 32 (briefs): `emitter.on('collection.updated', data)`. */
export function webhookEmitter(store: WebhookStore, ctx: Ctx, opts: DeliveryOptions = {}): WebhookEmitter {
  return {
    async on(type, data) {
      try {
        return await emit({ type, data }, store, ctx, opts);
      } catch (err) {
        ctx.log.warn('webhook emit failed', { type, message: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
  };
}
