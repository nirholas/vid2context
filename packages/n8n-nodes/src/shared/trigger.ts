/**
 * The trigger node's lifecycle against the vid2context API: register a
 * webhook on activation, check it still exists, delete it on deactivation.
 * `request` is n8n's authenticated request helper in the node and a plain
 * HTTP client in tests, so this logic runs against a real server either way.
 */
import type { IHttpRequestOptions } from 'n8n-workflow';
import { createWebhookRequest, deleteWebhookRequest, type FullResponse, listWebhooksRequest } from './requests.ts';

export type Requester = (options: IHttpRequestOptions) => Promise<unknown>;

/** What the trigger keeps in the workflow's static data between activation and deactivation. */
export interface Registration {
  webhookId: string;
  secret: string;
  url: string;
}

interface ListedWebhook {
  id: string;
  url: string;
  disabledAt?: string;
}

export async function registerWebhook(
  request: Requester,
  base: string,
  input: { url: string; events: string[]; description?: string },
): Promise<Registration> {
  if (input.events.length === 0) throw new Error('Pick at least one event for the vid2context Trigger.');
  const created = (await request(createWebhookRequest(base, input))) as { id?: string; secret?: string; url?: string };
  if (!created?.id || !created.secret) throw new Error('vid2context did not return a webhook id and secret.');
  return { webhookId: created.id, secret: created.secret, url: created.url ?? input.url };
}

/** True when the hook is still registered for this URL and not disabled. */
export async function webhookExists(request: Requester, base: string, reg: Partial<Registration>): Promise<boolean> {
  if (!reg.webhookId || !reg.secret) return false;
  const listed = (await request(listWebhooksRequest(base))) as { webhooks?: ListedWebhook[] };
  const hook = listed?.webhooks?.find((w) => w.id === reg.webhookId);
  return Boolean(hook && !hook.disabledAt && (!reg.url || hook.url === reg.url));
}

/** Deletes the hook. A 404 means it is already gone, which is fine. */
export async function unregisterWebhook(request: Requester, base: string, webhookId: string): Promise<void> {
  const res = (await request(deleteWebhookRequest(base, webhookId))) as FullResponse;
  if (res.statusCode !== 204 && res.statusCode !== 404 && (res.statusCode < 200 || res.statusCode >= 300)) {
    throw new Error(`vid2context answered HTTP ${res.statusCode} when deleting webhook ${webhookId}.`);
  }
}
