/**
 * Webhook subscriptions, kept in any KvStore under `webhooks:` keys. The
 * secret is stored because every delivery is signed with it; it is returned
 * once, from `create`, and never from `list` or `get`.
 */
import { type Ctx, hasKv, type KvStore, MemoryKv, type Storage, Vid2ContextError } from '@vid2context/core';
import { type AnyEventType, isWebhookEvent, WEBHOOK_EVENTS } from './events.ts';
import { generateSecret } from './signing.ts';
import { checkWebhookUrl, type UrlGuardOptions } from './url-guard.ts';

export const KV_PREFIX = 'webhooks:';
/** A store holds at most this many hooks, so listing stays one cheap pass. */
export const MAX_WEBHOOKS = 100;

export interface WebhookRecord {
  id: string;
  url: string;
  /** Event types, or `['*']` for all of them. */
  events: string[];
  secret: string;
  description?: string;
  createdAt: string;
  /** Set when deliveries were stopped (20 consecutive failures, or the receiver answered 410 Gone). */
  disabledAt?: string;
  disabledReason?: string;
  /** Consecutive failed delivery attempts; a success resets it. */
  failures: number;
  lastAttemptAt?: string;
  lastStatus?: number;
  lastError?: string;
}

/** The public view: everything but the secret. */
export type Webhook = Omit<WebhookRecord, 'secret'>;

export interface CreateWebhookInput {
  url: string;
  events: string[];
  description?: string;
}

export function publicView(record: WebhookRecord): Webhook {
  const { secret: _secret, ...rest } = record;
  return rest;
}

function badRequest(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `wh_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Validates and normalizes an events list: known types, or `*`; deduplicated. */
export function normalizeEvents(events: unknown): string[] {
  if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === 'string')) {
    throw badRequest(
      'events must be a non-empty array of event types.',
      `Use any of: ${WEBHOOK_EVENTS.join(', ')}, or "*" for all.`,
    );
  }
  const unknown = events.filter((e) => e !== '*' && !isWebhookEvent(e));
  if (unknown.length > 0) {
    throw badRequest(`Unknown webhook event: ${unknown.join(', ')}`, `Use any of: ${WEBHOOK_EVENTS.join(', ')}, or "*" for all.`);
  }
  return events.includes('*') ? ['*'] : [...new Set(events as string[])];
}

export class WebhookStore {
  constructor(readonly kv: KvStore) {}

  /** The store over `storage` when it implements KvStore, otherwise over `fallback` (keep one per process). */
  static forStorage(storage: Storage | null | undefined, fallback: KvStore): WebhookStore {
    return new WebhookStore(hasKv(storage) ? storage : fallback);
  }

  /** A process-local store (lost on restart), for tests and single-process tools. */
  static inMemory(): WebhookStore {
    return new WebhookStore(new MemoryKv());
  }

  private key(id: string): string {
    return `${KV_PREFIX}${id}`;
  }

  /** Registers a hook. The returned record includes the secret: show it once. */
  async create(input: CreateWebhookInput, ctx: Ctx, guard: UrlGuardOptions = {}): Promise<WebhookRecord> {
    if (typeof input?.url !== 'string' || input.url.length === 0) {
      throw badRequest('url is required.', 'POST { "url": "https://example.com/hook", "events": ["collection.updated"] }.');
    }
    const url = await checkWebhookUrl(input.url, ctx, guard);
    const events = normalizeEvents(input.events);
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) {
      throw badRequest('description must be a string of at most 500 characters.', 'Shorten the description or leave it out.');
    }
    const existing = await this.ids();
    if (existing.length >= MAX_WEBHOOKS) {
      throw badRequest(
        `This server already has ${MAX_WEBHOOKS} webhooks.`,
        'Delete unused webhooks (DELETE /api/v1/webhooks/:id) first.',
      );
    }
    const record: WebhookRecord = {
      id: randomId(),
      url: url.href,
      events,
      secret: generateSecret(),
      ...(input.description ? { description: input.description } : {}),
      createdAt: new Date().toISOString(),
      failures: 0,
    };
    await this.kv.kvSet(this.key(record.id), record);
    return record;
  }

  /** The full record, secret included. For delivery code, not for responses. */
  async get(id: string): Promise<WebhookRecord | null> {
    return this.kv.kvGet<WebhookRecord>(this.key(id));
  }

  async ids(): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.kvList(KV_PREFIX, { limit: 100, cursor });
      out.push(...page.keys.map((k) => k.slice(KV_PREFIX.length)));
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  async records(): Promise<WebhookRecord[]> {
    const all = await Promise.all((await this.ids()).map((id) => this.get(id)));
    return all.filter((r): r is WebhookRecord => r !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Every hook without its secret, oldest first. */
  async list(): Promise<Webhook[]> {
    return (await this.records()).map(publicView);
  }

  /** Enabled hooks subscribed to `type`. */
  async subscribers(type: AnyEventType): Promise<WebhookRecord[]> {
    return (await this.records()).filter((r) => !r.disabledAt && (r.events.includes('*') || r.events.includes(type)));
  }

  async delete(id: string): Promise<boolean> {
    const found = await this.get(id);
    if (!found) return false;
    await this.kv.kvDelete(this.key(id));
    return true;
  }

  private async patch(id: string, fn: (r: WebhookRecord) => void): Promise<WebhookRecord | null> {
    const record = await this.get(id);
    if (!record) return null;
    fn(record);
    await this.kv.kvSet(this.key(id), record);
    return record;
  }

  /** A delivery succeeded: reset the failure count. `reenable` also clears a disable (used by the test ping). */
  recordSuccess(id: string, status: number, opts: { reenable?: boolean } = {}): Promise<WebhookRecord | null> {
    return this.patch(id, (r) => {
      r.failures = 0;
      r.lastAttemptAt = new Date().toISOString();
      r.lastStatus = status;
      delete r.lastError;
      if (opts.reenable) {
        delete r.disabledAt;
        delete r.disabledReason;
      }
    });
  }

  /** A delivery attempt failed. Disables the hook at `maxFailures` consecutive failures, or at once when `disable` is given. */
  recordFailure(
    id: string,
    failure: { status?: number; error: string; disable?: string },
    maxFailures: number,
  ): Promise<WebhookRecord | null> {
    return this.patch(id, (r) => {
      r.failures += 1;
      r.lastAttemptAt = new Date().toISOString();
      if (failure.status === undefined) delete r.lastStatus;
      else r.lastStatus = failure.status;
      r.lastError = failure.error.slice(0, 300);
      const reason = failure.disable ?? (r.failures >= maxFailures ? `${r.failures} consecutive failed deliveries` : undefined);
      if (reason && !r.disabledAt) {
        r.disabledAt = r.lastAttemptAt;
        r.disabledReason = reason;
      }
    });
  }
}
