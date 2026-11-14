/**
 * Durable retries on Cloudflare Workers through Cloudflare Queues, the same
 * queue service the jobs package runs on (its QueueProducer and MessageBatch
 * types, imported as types only so this file adds no runtime dependency).
 *
 * The in-process default scheduler uses setTimeout, which on Workers ends
 * with the request. With `queueRetryScheduler(env.WEBHOOKS)` a failed attempt
 * becomes a delayed queue message `{ webhookDelivery: DeliveryTask }`, and the
 * Worker's `queue()` handler runs it with `handleWebhookRetryBatch`, which
 * schedules any further retry the same way. The task is plain JSON (hook id,
 * message id, body, attempt), so nothing but the queue and the hook store
 * (Workers KV through `workersKv` from the jobs package, or D1) is needed.
 *
 * The jobs consumer acks and drops messages without a `jobId`, so either give
 * webhook retries their own queue, or run `handleWebhookRetryBatch` first and
 * pass the messages it returns to the jobs consumer.
 */
import type { Ctx } from '@vid2context/core';
import type { MessageBatch, QueueMessage, QueueProducer } from '@vid2context/jobs';
import { type DeliveryOptions, type DeliveryTask, deliverTask, type RetryScheduler } from './deliver.ts';
import type { WebhookStore } from './store.ts';

/** Cloudflare Queues accepts delays up to 12 hours; the longest default retry delay is 8 hours. */
export const MAX_QUEUE_DELAY_SECONDS = 43_200;

/** The queue message one pending retry becomes. */
export interface WebhookRetryMessage {
  webhookDelivery: DeliveryTask;
}

export function isWebhookRetryMessage(body: unknown): body is WebhookRetryMessage {
  const task = (body as Partial<WebhookRetryMessage> | null)?.webhookDelivery;
  return (
    typeof task === 'object' &&
    task !== null &&
    typeof task.hookId === 'string' &&
    typeof task.messageId === 'string' &&
    typeof task.type === 'string' &&
    typeof task.body === 'string' &&
    Number.isInteger(task.attempt) &&
    task.attempt >= 0
  );
}

/** A RetryScheduler that sends each retry to a Cloudflare Queue, delayed by the backoff (rounded up to whole seconds, at most 12 hours). */
export function queueRetryScheduler(queue: QueueProducer<WebhookRetryMessage>): RetryScheduler {
  return {
    async schedule(task, delayMs) {
      const delaySeconds = Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(0, Math.ceil(delayMs / 1000)));
      await queue.send({ webhookDelivery: task }, { contentType: 'json', ...(delaySeconds > 0 ? { delaySeconds } : {}) });
    },
  };
}

export interface WebhookQueueDeps {
  store: WebhookStore;
  ctx: Ctx;
  /** The producer binding of the same queue, for the next retry of a task that fails again. */
  queue: QueueProducer<WebhookRetryMessage>;
  /** Delivery settings; keep them the same as the ones `emit` used, so the attempt count and backoff match. */
  delivery?: Omit<DeliveryOptions, 'scheduler'>;
}

/**
 * Consumer body for the Worker's `queue(batch, env)` handler. Runs every
 * webhook retry in the batch, one after another, and acks it once the attempt
 * ran (delivered, rescheduled, failed for good or skipped). If running the
 * attempt itself throws (the hook store is down), the message is retried with
 * the queue's own delay. Messages that are not webhook retries are left
 * untouched and returned, for the jobs consumer or any other handler.
 */
export async function handleWebhookRetryBatch<Body = unknown>(
  batch: MessageBatch<Body>,
  deps: WebhookQueueDeps,
): Promise<QueueMessage<Body>[]> {
  const rest: QueueMessage<Body>[] = [];
  const opts: DeliveryOptions = { ...deps.delivery, scheduler: queueRetryScheduler(deps.queue) };
  for (const msg of batch.messages) {
    if (!isWebhookRetryMessage(msg.body)) {
      rest.push(msg);
      continue;
    }
    const task = msg.body.webhookDelivery;
    try {
      await deliverTask(task, deps.store, deps.ctx, opts);
      msg.ack();
    } catch (err) {
      deps.ctx.log.error('webhook queue retry crashed', {
        hookId: task.hookId,
        messageId: task.messageId,
        message: err instanceof Error ? err.message : String(err),
      });
      msg.retry();
    }
  }
  return rest;
}
