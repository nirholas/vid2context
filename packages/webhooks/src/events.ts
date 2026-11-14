/**
 * Webhook event types and payloads. A payload is `{ type, timestamp, data }`
 * (the Standard Webhooks shape). `data` carries ids, titles and links to the
 * HTTP API, never transcripts: a receiver that wants the text follows the
 * link. The builders below pick those fields from core types, so emitters
 * cannot leak a transcript by accident.
 */
import type { Collection, Ctx, TranscriptOrigin, VideoContext, VideoSummary } from '@vid2context/core';

export const WEBHOOK_EVENTS = ['video.ingested', 'collection.updated', 'job.succeeded', 'job.failed', 'brief.ready'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
/** Sent only by `POST /webhooks/:id/test`, to every hook regardless of its events. */
export const TEST_EVENT = 'test.ping';

/** A video as it appears in event data. */
export interface VideoEventItem {
  id: string;
  title: string;
  url?: string;
  platform: string;
  channel?: string;
  durationSec?: number;
  origin?: TranscriptOrigin;
  language?: string;
  links: { context: string; transcript: string };
}

export interface VideoIngestedData {
  video: VideoEventItem;
  /** Set when the video was ingested into a collection. */
  collectionId?: string;
  /** Set when the ingest ran as a job. */
  jobId?: string;
}

export interface CollectionUpdatedData {
  collection: { id: string; name: string; videoCount: number; links: { collection: string } };
  added: VideoEventItem[];
  removed: string[];
  /** When the sources were last checked (ISO 8601), for refreshes. */
  checkedAt?: string;
}

export interface JobEventData {
  job: {
    id: string;
    kind: string;
    status: string;
    error?: { code: string; message: string; hint?: string };
    createdAt: string;
    updatedAt: string;
    links: { job: string };
  };
}

export interface BriefReadyData {
  brief: {
    /** The brief's own id when it is stored, otherwise the job id that produced it. */
    id: string;
    jobId?: string;
    collectionId?: string;
    question?: string;
    template?: string;
    claims?: number;
    videoCount?: number;
    /** `job` is set when a job produced the brief: GET it for the full result. */
    links: { job?: string };
  };
}

export interface TestPingData {
  webhookId: string;
  message: string;
}

export interface WebhookEventData {
  'video.ingested': VideoIngestedData;
  'collection.updated': CollectionUpdatedData;
  'job.succeeded': JobEventData;
  'job.failed': JobEventData;
  'brief.ready': BriefReadyData;
  'test.ping': TestPingData;
}

export type AnyEventType = keyof WebhookEventData;

export interface WebhookPayload<T extends AnyEventType = AnyEventType> {
  type: T;
  /** When the event happened (ISO 8601). Retries keep it; the webhook-timestamp header is per attempt. */
  timestamp: string;
  data: WebhookEventData[T];
}

export function isWebhookEvent(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Links in payloads: absolute when VID2CONTEXT_WEBHOOKS_BASE_URL is set, otherwise paths under /api/v1. */
export function apiLink(ctx: Pick<Ctx, 'env'> | undefined, path: string): string {
  const base = (ctx?.env.VID2CONTEXT_WEBHOOKS_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/v1${path}`;
}

function isContext(v: VideoContext | VideoSummary): v is VideoContext {
  return 'metadata' in v && 'transcript' in v;
}

/** The event view of a saved video (a full VideoContext or a library VideoSummary). Never includes transcript text. */
export function videoItem(source: VideoContext | VideoSummary, ctx?: Pick<Ctx, 'env'>): VideoEventItem {
  const ref = isContext(source) ? source.metadata.ref : source.ref;
  const item: VideoEventItem = isContext(source)
    ? {
        id: ref.id,
        title: source.metadata.title,
        url: ref.url,
        platform: ref.platform,
        channel: source.metadata.channel?.name,
        durationSec: source.metadata.durationSec,
        origin: source.transcript.origin,
        language: source.transcript.language,
        links: { context: '', transcript: '' },
      }
    : {
        id: source.id,
        title: source.title,
        url: ref.url,
        platform: ref.platform,
        channel: source.channel,
        durationSec: source.durationSec,
        origin: source.origin,
        language: source.language,
        links: { context: '', transcript: '' },
      };
  item.links = {
    context: apiLink(ctx, `/library/${encodeURIComponent(ref.id)}`),
    transcript: apiLink(ctx, `/transcript?url=${encodeURIComponent(ref.url ?? ref.id)}`),
  };
  for (const key of Object.keys(item) as (keyof VideoEventItem)[]) if (item[key] === undefined) delete item[key];
  return item;
}

export function videoIngestedData(
  source: VideoContext | VideoSummary,
  opts: { collectionId?: string; jobId?: string } = {},
  ctx?: Pick<Ctx, 'env'>,
): VideoIngestedData {
  return { video: videoItem(source, ctx), ...opts };
}

export function collectionUpdatedData(
  collection: Pick<Collection, 'id' | 'name' | 'videoIds'>,
  change: { added?: (VideoContext | VideoSummary)[]; removed?: string[]; checkedAt?: string },
  ctx?: Pick<Ctx, 'env'>,
): CollectionUpdatedData {
  return {
    collection: {
      id: collection.id,
      name: collection.name,
      videoCount: collection.videoIds.length,
      links: { collection: apiLink(ctx, `/collections/${encodeURIComponent(collection.id)}`) },
    },
    added: (change.added ?? []).map((v) => videoItem(v, ctx)),
    removed: change.removed ?? [],
    ...(change.checkedAt ? { checkedAt: change.checkedAt } : {}),
  };
}

/** The fields of the contract's Job shape (docs/contracts/http-api.md) that events carry. `result` is left out: follow the link. */
export interface JobLike {
  id: string;
  kind: string;
  status: string;
  error?: { code: string; message: string; hint?: string };
  createdAt: string;
  updatedAt: string;
}

export function jobData(job: JobLike, ctx?: Pick<Ctx, 'env'>): JobEventData {
  return {
    job: {
      id: job.id,
      kind: job.kind,
      status: job.status,
      ...(job.error ? { error: { code: job.error.code, message: job.error.message, hint: job.error.hint } } : {}),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      links: { job: apiLink(ctx, `/jobs/${encodeURIComponent(job.id)}`) },
    },
  };
}

export function briefReadyData(
  brief: {
    id?: string;
    jobId?: string;
    collectionId?: string;
    question?: string;
    template?: string;
    claims?: number;
    videoCount?: number;
  },
  ctx?: Pick<Ctx, 'env'>,
): BriefReadyData {
  const id = brief.id ?? brief.jobId;
  if (!id) throw new TypeError('briefReadyData needs the brief id or the job id that produced it');
  const links = brief.jobId ? { job: apiLink(ctx, `/jobs/${encodeURIComponent(brief.jobId)}`) } : {};
  const out: BriefReadyData = { brief: { ...brief, id, links } };
  for (const key of Object.keys(out.brief) as (keyof BriefReadyData['brief'])[]) {
    if (out.brief[key] === undefined) delete out.brief[key];
  }
  return out;
}
