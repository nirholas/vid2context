/**
 * Notion export: one page per video under a parent page, built with plain
 * fetch against the public API (https://developers.notion.com/reference).
 *
 * Page layout: a gray marker paragraph (see below), the video's facts, a
 * bookmark to the video, the summary callout when a brief exists, a folded
 * description, one heading per chapter (or "Transcript"), paragraphs that start
 * with a timestamp link, and the comments when present.
 *
 * Limits honoured (checked 2026-11-14 at developers.notion.com/reference/request-limits):
 * 2000 characters per rich text `content` and per link URL, 100 blocks per
 * `children` array and per rich text array, 1000 block elements and 500 KB per
 * request, and about 3 requests per second per integration. Requests are paced
 * and 429 or 529 answers are retried after `Retry-After`.
 *
 * Idempotency: pages under a page have only a title property, so the id lives
 * in the first block, a gray paragraph reading
 *
 *   vid2context-id: youtube:cCPsdFdlshc
 *   vid2context-digest: 7a5c2cd11605b19c
 *
 * A later export lists the parent's child pages, reads each one's first block
 * and updates the page with the same id instead of creating a duplicate. The
 * digest (SHA-256 of the planned title and blocks) lets an unchanged page be
 * skipped. While a multi-request write is in progress the digest reads
 * "incomplete", so an interrupted export is rewritten next time.
 */

import type { VideoContext } from '@vid2context/core';
import {
  type Comment,
  type Ctx,
  errorFromResponse,
  fetchWithTimeout,
  formatTimestamp,
  Vid2ContextError,
} from '@vid2context/core';
import { type LayoutOptions, layoutTranscript } from './layout.ts';

export const NOTION_API = 'https://api.notion.com/v1';
/** Notion-Version header. 2026-03-11 is the current version (developers.notion.com/reference/versioning, checked 2026-11-14). */
export const NOTION_VERSION = '2026-03-11';

export const NOTION_TEXT_LIMIT = 2000;
export const NOTION_CHILDREN_LIMIT = 100;
export const NOTION_RICH_TEXT_ITEMS_LIMIT = 100;
export const NOTION_ELEMENTS_LIMIT = 1000;
/** Stay well under the 500 KB payload limit. */
export const NOTION_PAYLOAD_BUDGET = 400_000;

const INCOMPLETE = 'incomplete';

export interface RichText {
  type: 'text';
  text: { content: string; link?: { url: string } };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean; color?: string };
}

export interface NotionBlock {
  object: 'block';
  type: string;
  [key: string]: unknown;
}

export interface NotionPagePlan {
  videoId: string;
  title: string;
  /** Every top-level block in page order, the marker first. */
  blocks: NotionBlock[];
  /** `blocks` cut into request-sized batches, in order: the first goes with page creation, the rest are appended. */
  batches: NotionBlock[][];
  digest: string;
}

export interface NotionPlanOptions {
  /** Existing briefs or summaries keyed by video id. A page gets a summary callout only when its video has one. */
  briefs?: Record<string, string>;
  layout?: LayoutOptions;
}

export interface NotionExportOptions extends NotionPlanOptions {
  /** Page id or page URL to create the pages under. Default: `NOTION_PARENT_PAGE_ID` from ctx.env. */
  parentPageId?: string;
  /** Integration token. Default: `NOTION_TOKEN` from ctx.env. */
  token?: string;
  /** Minimum gap between requests. Default 350 ms (under Notion's 3 requests per second). */
  minIntervalMs?: number;
  /** Retries for 429 and 529 answers. Default 5. */
  maxRetries?: number;
}

export interface NotionPageResult {
  videoId: string;
  pageId: string;
  url: string;
  status: 'created' | 'updated' | 'unchanged';
}

// ---------------------------------------------------------------- building blocks

/** Split text into pieces of at most `limit` UTF-16 units, preferring whitespace, never splitting a surrogate pair. */
export function splitText(text: string, limit = NOTION_TEXT_LIMIT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.6) cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}

/** Rich text items for `text`, each within the 2000-character limit. Links longer than the URL limit are dropped. */
export function richText(text: string, opts: { link?: string; bold?: boolean; code?: boolean; color?: string } = {}): RichText[] {
  const link = opts.link && opts.link.length <= NOTION_TEXT_LIMIT && /^https?:\/\//i.test(opts.link) ? opts.link : undefined;
  const annotations =
    opts.bold || opts.code || opts.color
      ? {
          ...(opts.bold ? { bold: true } : {}),
          ...(opts.code ? { code: true } : {}),
          ...(opts.color ? { color: opts.color } : {}),
        }
      : undefined;
  return splitText(text).map((content) => ({
    type: 'text' as const,
    text: link ? { content, link: { url: link } } : { content },
    ...(annotations ? { annotations } : {}),
  }));
}

function block(type: string, body: Record<string, unknown>): NotionBlock {
  return { object: 'block', type, [type]: body };
}

/** One or more blocks of `type` holding `items`, so no block has more than 100 rich text items. */
function textBlocks(type: string, items: RichText[], extra: Record<string, unknown> = {}): NotionBlock[] {
  const out: NotionBlock[] = [];
  for (let i = 0; i < items.length || i === 0; i += NOTION_RICH_TEXT_ITEMS_LIMIT) {
    out.push(block(type, { rich_text: items.slice(i, i + NOTION_RICH_TEXT_ITEMS_LIMIT), ...extra }));
  }
  return out;
}

function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function datePart(iso: string | undefined): string | undefined {
  return iso?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
}

/** The marker paragraph that identifies a page as vid2context's export of one video. */
export function markerBlock(videoId: string, digest: string): NotionBlock {
  return block('paragraph', {
    rich_text: richText(`vid2context-id: ${videoId}\nvid2context-digest: ${digest}`),
    color: 'gray',
  });
}

/** Reads a marker's text back. */
export function parseMarker(text: string): { id: string; digest?: string } | undefined {
  const id = text.match(/^vid2context-id: (.+)$/m)?.[1]?.trim();
  if (!id) return undefined;
  return { id, digest: text.match(/^vid2context-digest: (\S+)$/m)?.[1] };
}

function commentBlock(c: Comment, depth: number): NotionBlock {
  const flags = [
    c.isCreator ? 'creator' : undefined,
    c.isPinned ? 'pinned' : undefined,
    c.likes !== undefined ? `${c.likes} likes` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  const items = [...richText(c.author, { bold: true }), ...richText(`${flags ? ` (${flags})` : ''}: ${c.text.trim()}`)];
  const replies = depth === 0 ? (c.replies ?? []).slice(0, NOTION_CHILDREN_LIMIT).map((r) => commentBlock(r, 1)) : [];
  return block('bulleted_list_item', {
    rich_text: items.slice(0, NOTION_RICH_TEXT_ITEMS_LIMIT),
    ...(replies.length > 0 ? { children: replies } : {}),
  });
}

/** The page's content blocks, without the marker. */
export function notionBlocks(context: VideoContext, opts: NotionPlanOptions = {}): NotionBlock[] {
  const m = context.metadata;
  const t = context.transcript;
  const blocks: NotionBlock[] = [];
  const facts = [
    m.channel ? `Channel: ${m.channel.name}` : undefined,
    m.durationSec !== undefined ? `Duration: ${formatTimestamp(m.durationSec)}` : undefined,
    datePart(m.publishedAt) ? `Published: ${datePart(m.publishedAt)}` : undefined,
    `Transcript: ${t.origin}, ${t.language}${t.translated ? ', machine-translated' : ''} (${t.producer})`,
  ].filter(Boolean);
  blocks.push(...textBlocks('paragraph', richText(facts.join('\n'))));
  if (m.ref.url && /^https?:\/\//i.test(m.ref.url) && m.ref.url.length <= NOTION_TEXT_LIMIT) {
    blocks.push(block('bookmark', { url: m.ref.url, caption: [] }));
  }
  const brief = opts.briefs?.[m.ref.id]?.trim();
  if (brief) {
    const [first, ...rest] = paragraphs(brief);
    blocks.push(
      block('callout', {
        rich_text: [...richText('Summary', { bold: true }), ...richText(`\n${first ?? ''}`)].slice(
          0,
          NOTION_RICH_TEXT_ITEMS_LIMIT,
        ),
        color: 'gray_background',
        ...(rest.length > 0
          ? { children: rest.slice(0, NOTION_CHILDREN_LIMIT).flatMap((p) => textBlocks('paragraph', richText(p)).slice(0, 1)) }
          : {}),
      }),
    );
  }
  if (m.description?.trim()) {
    const parts = paragraphs(m.description).slice(0, NOTION_CHILDREN_LIMIT);
    blocks.push(
      block('toggle', {
        rich_text: richText('Description', { bold: true }),
        children: parts.flatMap((p) => textBlocks('paragraph', richText(p)).slice(0, 1)),
      }),
    );
  }
  for (const section of layoutTranscript(context, opts.layout)) {
    const heading = section.chapter
      ? [...richText(section.stamp, { link: section.url, code: !section.url }), ...richText(` ${section.title}`)]
      : richText(section.title);
    blocks.push(block('heading_2', { rich_text: heading.slice(0, NOTION_RICH_TEXT_ITEMS_LIMIT) }));
    for (const p of section.paragraphs) {
      blocks.push(...textBlocks('paragraph', [...richText(p.stamp, { link: p.url, code: !p.url }), ...richText(` ${p.text}`)]));
    }
  }
  if (context.comments && context.comments.length > 0) {
    blocks.push(block('heading_2', { rich_text: richText('Comments') }));
    for (const c of context.comments) blocks.push(commentBlock(c, 0));
  }
  return blocks;
}

/** Block elements a block adds to a request (itself plus nested children). */
export function elementCount(b: NotionBlock): number {
  const body = b[b.type] as { children?: NotionBlock[] } | undefined;
  return 1 + (body?.children ?? []).reduce((sum, c) => sum + elementCount(c), 0);
}

/** Cut blocks into ordered batches within 100 top-level blocks, 1000 elements and the payload budget per request. */
export function batchBlocks(blocks: NotionBlock[]): NotionBlock[][] {
  const batches: NotionBlock[][] = [];
  let current: NotionBlock[] = [];
  let elements = 0;
  let bytes = 0;
  for (const b of blocks) {
    const n = elementCount(b);
    const size = new TextEncoder().encode(JSON.stringify(b)).length;
    if (
      current.length > 0 &&
      (current.length + 1 > NOTION_CHILDREN_LIMIT || elements + n > NOTION_ELEMENTS_LIMIT || bytes + size > NOTION_PAYLOAD_BUDGET)
    ) {
      batches.push(current);
      current = [];
      elements = 0;
      bytes = 0;
    }
    current.push(b);
    elements += n;
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Everything that will be sent for one video, before any request is made. */
export async function planNotionPage(context: VideoContext, opts: NotionPlanOptions = {}): Promise<NotionPagePlan> {
  const videoId = context.metadata.ref.id;
  const title = context.metadata.title.trim() || videoId;
  const content = notionBlocks(context, opts);
  const digest = (await sha256Hex(JSON.stringify({ v: 1, title, content }))).slice(0, 16);
  const blocks = [markerBlock(videoId, digest), ...content];
  return { videoId, title, blocks, batches: batchBlocks(blocks), digest };
}

/** Accepts a page id with or without dashes, or a Notion page URL, and returns the dashed id. */
export function notionId(input: string): string | undefined {
  const last = input.trim().split(/[?#]/)[0]?.split('/').pop() ?? '';
  const hex = last
    .replace(/-/g, '')
    .match(/[0-9a-f]{32}$/i)?.[0]
    ?.toLowerCase();
  if (!hex) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

// ---------------------------------------------------------------- the API client

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const HINTS: Partial<Record<Vid2ContextError['code'], string>> = {
  auth: 'Check NOTION_TOKEN (an internal integration secret from https://www.notion.so/profile/integrations) and share the parent page with that integration (page menu, Connections).',
  'not-found': 'Share the parent page with your integration (page menu, Connections) and check NOTION_PARENT_PAGE_ID.',
  'rate-limited':
    'Notion allows about 3 requests per second per integration. Wait a minute and run the export again; finished pages are skipped.',
  upstream:
    'Notion rejected the request; the message carries its reason. Run the export again to retry; finished pages are skipped.',
};

interface ChildPage {
  id: string;
  title: string;
}

interface BlockList {
  results: ({ id: string; type: string } & Record<string, unknown>)[];
  has_more?: boolean;
  next_cursor?: string | null;
}

class NotionClient {
  private last = 0;

  constructor(
    private readonly token: string,
    private readonly ctx: Ctx,
    private readonly minIntervalMs: number,
    private readonly maxRetries: number,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait, this.ctx.signal);
      this.last = Date.now();
      const res = await fetchWithTimeout(
        this.ctx,
        `${NOTION_API}${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            'notion-version': NOTION_VERSION,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        60_000,
      );
      if (res.ok) return (await res.json()) as T;
      const err = await errorFromResponse(res, `Notion ${method} ${path.split('?')[0]}`);
      const retryable = (err.status === 429 && !err.message.includes('public_api_request_blocked')) || err.status === 529;
      if (retryable && attempt < this.maxRetries) {
        const delay = err.retryAfterSec ? err.retryAfterSec * 1000 : Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 250;
        this.ctx.log.warn('Notion asked to slow down, retrying', { status: err.status, delayMs: Math.round(delay) });
        await sleep(delay, this.ctx.signal);
        continue;
      }
      throw new Vid2ContextError(err.code, err.message, {
        hint: err.hint ?? HINTS[err.code],
        status: err.status,
        retryAfterSec: err.retryAfterSec,
        cause: err,
      });
    }
  }

  async childPages(parentId: string): Promise<ChildPage[]> {
    const pages: ChildPage[] = [];
    let cursor: string | undefined;
    do {
      const list = await this.request<BlockList>(
        'GET',
        `/blocks/${parentId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      for (const b of list.results) {
        if (b.type === 'child_page')
          pages.push({ id: b.id, title: (b.child_page as { title?: string } | undefined)?.title ?? '' });
      }
      cursor = list.has_more && list.next_cursor ? list.next_cursor : undefined;
    } while (cursor);
    return pages;
  }

  async firstBlock(pageId: string): Promise<{ id: string; text: string } | undefined> {
    const list = await this.request<BlockList>('GET', `/blocks/${pageId}/children?page_size=1`);
    const b = list.results[0];
    if (!b) return undefined;
    if (b.type !== 'paragraph') return { id: b.id, text: '' };
    const rt =
      (b.paragraph as { rich_text?: { plain_text?: string; text?: { content?: string } }[] } | undefined)?.rich_text ?? [];
    return { id: b.id, text: rt.map((r) => r.plain_text ?? r.text?.content ?? '').join('') };
  }
}

/** Finds the existing page for a video under the parent, reading each child page's marker at most once per export. */
class PageIndex {
  private pages: ChildPage[] | undefined;
  private markers = new Map<string, { id: string; digest?: string; blockId: string } | null>();

  constructor(
    private readonly client: NotionClient,
    private readonly parentId: string,
  ) {}

  private async marker(pageId: string) {
    if (!this.markers.has(pageId)) {
      const first = await this.client.firstBlock(pageId);
      const parsed = first ? parseMarker(first.text) : undefined;
      this.markers.set(pageId, parsed && first ? { ...parsed, blockId: first.id } : null);
    }
    return this.markers.get(pageId) ?? null;
  }

  async find(videoId: string, title: string): Promise<{ page: ChildPage; digest?: string } | undefined> {
    this.pages ??= await this.client.childPages(this.parentId);
    const ordered = [...this.pages.filter((p) => p.title === title), ...this.pages.filter((p) => p.title !== title)];
    for (const page of ordered) {
      const m = await this.marker(page.id);
      if (m?.id === videoId) return { page, digest: m.digest };
    }
    return undefined;
  }

  add(page: ChildPage, videoId: string, digest: string, blockId: string): void {
    this.pages?.push(page);
    this.markers.set(page.id, { id: videoId, digest, blockId });
  }
}

/** Resolve token and parent page from options or ctx.env, with errors that say how to fix each. */
export function notionConfig(
  opts: Pick<NotionExportOptions, 'token' | 'parentPageId'>,
  ctx: Ctx,
): { token: string; parentId: string } {
  const token = opts.token ?? ctx.env.NOTION_TOKEN;
  if (!token) {
    throw new Vid2ContextError('no-provider', 'NOTION_TOKEN is not set.', {
      hint: 'Create an internal integration at https://www.notion.so/profile/integrations, share the parent page with it (page menu, Connections) and set NOTION_TOKEN to its secret.',
    });
  }
  const rawParent = opts.parentPageId ?? ctx.env.NOTION_PARENT_PAGE_ID;
  if (!rawParent) {
    throw new Vid2ContextError('bad-request', 'No Notion parent page given.', {
      hint: 'Pass parentPageId, or set NOTION_PARENT_PAGE_ID to the id or URL of the page the video pages go under.',
    });
  }
  const parentId = notionId(rawParent);
  if (!parentId) {
    throw new Vid2ContextError('bad-request', `Not a Notion page id or URL: ${rawParent.slice(0, 200)}`, {
      hint: 'Copy the page link from Notion (Share, Copy link); it ends in a 32-character id.',
    });
  }
  return { token, parentId };
}

async function appendBatches(client: NotionClient, pageId: string, batches: NotionBlock[][]): Promise<BlockList | undefined> {
  let first: BlockList | undefined;
  for (const children of batches) {
    const res = await client.request<BlockList>('PATCH', `/blocks/${pageId}/children`, { children });
    first ??= res;
  }
  return first;
}

/**
 * Create or update one Notion page per video under the parent page. Pages are
 * written one after another, each in order, and the results keep input order.
 */
export async function exportNotion(contexts: VideoContext[], opts: NotionExportOptions, ctx: Ctx): Promise<NotionPageResult[]> {
  const { token, parentId } = notionConfig(opts, ctx);
  const client = new NotionClient(token, ctx, opts.minIntervalMs ?? 350, opts.maxRetries ?? 5);
  const index = new PageIndex(client, parentId);
  const results: NotionPageResult[] = [];
  const done = new Set<string>();
  for (const context of contexts) {
    const plan = await planNotionPage(context, opts);
    if (done.has(plan.videoId)) continue;
    done.add(plan.videoId);
    const title = { title: richText(plan.title).slice(0, NOTION_RICH_TEXT_ITEMS_LIMIT) };
    // A page written in one request carries its final digest; a longer write marks itself incomplete until the last batch lands.
    const single = plan.batches.length === 1;
    const batches = single
      ? plan.batches
      : [[markerBlock(plan.videoId, INCOMPLETE), ...(plan.batches[0] ?? []).slice(1)], ...plan.batches.slice(1)];
    const existing = await index.find(plan.videoId, plan.title);

    if (existing && existing.digest === plan.digest && existing.page.title === plan.title) {
      ctx.log.info('Notion page unchanged', { videoId: plan.videoId, pageId: existing.page.id });
      results.push({ videoId: plan.videoId, pageId: existing.page.id, url: notionUrl(existing.page.id), status: 'unchanged' });
      continue;
    }

    let pageId: string;
    let url: string;
    let markerId: string | undefined;
    let status: NotionPageResult['status'];
    if (existing) {
      const page = await client.request<{ id: string; url?: string }>('PATCH', `/pages/${existing.page.id}`, {
        properties: { title },
        erase_content: true,
      });
      pageId = page.id;
      url = page.url ?? notionUrl(page.id);
      const first = await appendBatches(client, pageId, batches);
      markerId = first?.results[0]?.id;
      status = 'updated';
    } else {
      const page = await client.request<{ id: string; url?: string }>('POST', '/pages', {
        parent: { type: 'page_id', page_id: parentId },
        properties: { title },
        children: batches[0] ?? [],
      });
      pageId = page.id;
      url = page.url ?? notionUrl(page.id);
      await appendBatches(client, pageId, batches.slice(1));
      if (!single) markerId = (await client.firstBlock(pageId))?.id;
      status = 'created';
    }
    if (!single) {
      if (!markerId) {
        throw new Vid2ContextError('upstream', `Notion did not return the marker block of page ${pageId}.`, {
          hint: 'Run the export again; the page is marked incomplete and will be rewritten.',
        });
      }
      await client.request('PATCH', `/blocks/${markerId}`, { paragraph: markerBlock(plan.videoId, plan.digest).paragraph });
    }
    index.add({ id: pageId, title: plan.title }, plan.videoId, plan.digest, markerId ?? '');
    ctx.log.info(`Notion page ${status}`, {
      videoId: plan.videoId,
      pageId,
      blocks: plan.blocks.length,
      requests: plan.batches.length,
    });
    results.push({ videoId: plan.videoId, pageId, url, status });
  }
  return results;
}
