/**
 * No Notion token was available when this package was written, so these tests
 * cover request construction only: what would be sent, in what order and in
 * what sizes, built from the real shared contexts. No Notion response is
 * replayed here; the live test in notion.live.test.ts talks to the real API.
 */
import { readFileSync } from 'node:fs';
import { type Comment, segmentsToText, timestampUrl, type VideoContext } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import {
  batchBlocks,
  elementCount,
  exportNotion,
  NOTION_CHILDREN_LIMIT,
  NOTION_ELEMENTS_LIMIT,
  NOTION_PAYLOAD_BUDGET,
  NOTION_RICH_TEXT_ITEMS_LIMIT,
  NOTION_TEXT_LIMIT,
  type NotionBlock,
  notionConfig,
  notionId,
  notionUrl,
  parseMarker,
  planNotionPage,
  type RichText,
  richText,
  splitText,
} from '../src/notion.ts';

const fixture = (name: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${name}.json`, import.meta.url), 'utf8')) as VideoContext;

const zoo = fixture('youtube-jNQXAC9IVRw');
const gwagon = fixture('youtube-cCPsdFdlshc');
/** Real comments recorded for the same video (test/fixtures/README.md), attached the way the pipeline attaches them. */
const comments = JSON.parse(
  readFileSync(new URL('./fixtures/youtube-jNQXAC9IVRw.comments.json', import.meta.url), 'utf8'),
) as Comment[];
const withComments: VideoContext = { ...zoo, comments };

/** The page id used in Notion's own API reference examples. */
const DOCS_PAGE_ID = 'b55c9c91-384d-452b-81db-d1ef79372b75';

function body(b: NotionBlock): { rich_text?: RichText[]; children?: NotionBlock[]; url?: string; color?: string } {
  return b[b.type] as { rich_text?: RichText[]; children?: NotionBlock[]; url?: string; color?: string };
}

function allBlocks(blocks: NotionBlock[]): NotionBlock[] {
  return blocks.flatMap((b) => [b, ...allBlocks(body(b).children ?? [])]);
}

function plain(b: NotionBlock): string {
  return (body(b).rich_text ?? []).map((r) => r.text.content).join('');
}

function checkLimits(batches: NotionBlock[][]): void {
  for (const batch of batches) {
    expect(batch.length).toBeLessThanOrEqual(NOTION_CHILDREN_LIMIT);
    expect(batch.reduce((n, b) => n + elementCount(b), 0)).toBeLessThanOrEqual(NOTION_ELEMENTS_LIMIT);
    expect(new TextEncoder().encode(JSON.stringify({ children: batch })).length).toBeLessThan(NOTION_PAYLOAD_BUDGET + 100);
    for (const b of allBlocks(batch)) {
      const rt = body(b).rich_text ?? [];
      expect(rt.length).toBeLessThanOrEqual(NOTION_RICH_TEXT_ITEMS_LIMIT);
      expect((body(b).children ?? []).length).toBeLessThanOrEqual(NOTION_CHILDREN_LIMIT);
      for (const r of rt) {
        expect(r.text.content.length).toBeLessThanOrEqual(NOTION_TEXT_LIMIT);
        if (r.text.link) expect(r.text.link.url.length).toBeLessThanOrEqual(NOTION_TEXT_LIMIT);
      }
    }
  }
}

describe('planNotionPage', () => {
  it('starts with the id marker, then facts, a bookmark, the description and one heading per chapter', async () => {
    const plan = await planNotionPage(zoo);
    expect(plan.title).toBe('Me at the zoo');
    const [marker, facts, bookmark, description, ...rest] = plan.blocks;
    if (!marker || !facts || !bookmark || !description) throw new Error('missing blocks');
    expect(marker.type).toBe('paragraph');
    expect(body(marker).color).toBe('gray');
    expect(parseMarker(plain(marker))).toEqual({ id: 'youtube:jNQXAC9IVRw', digest: plan.digest });
    expect(plain(facts)).toBe('Channel: jawed\nDuration: 0:19\nTranscript: creator-captions, en (youtube-captions)');
    expect(bookmark).toEqual({ object: 'block', type: 'bookmark', bookmark: { url: zoo.metadata.ref.url, caption: [] } });
    expect(description.type).toBe('toggle');
    expect(plain(description)).toBe('Description');
    expect(rest.filter((b) => b.type === 'heading_2').map(plain)).toEqual(['0:00 Intro', '0:05 The cool thing', '0:17 End']);
    const heading = rest.find((b) => b.type === 'heading_2');
    expect(body(heading as NotionBlock).rich_text?.[0]?.text.link?.url).toBe(timestampUrl(zoo.metadata.ref, 0));
    expect(rest.some((b) => b.type === 'callout')).toBe(false);
  });

  it('starts every transcript paragraph with a timestamp link and keeps the full text in order', async () => {
    const plan = await planNotionPage(gwagon);
    expect(plan.blocks.filter((b) => b.type === 'heading_2').map(plain)).toEqual(['Transcript']);
    const paragraphs = plan.blocks.slice(plan.blocks.findIndex((b) => b.type === 'heading_2') + 1);
    expect(paragraphs.length).toBeGreaterThan(15);
    const text: string[] = [];
    for (const p of paragraphs) {
      const [stamp, ...words] = body(p).rich_text ?? [];
      const sec = Number(stamp?.text.link?.url.match(/&t=(\d+)s$/)?.[1]);
      expect(stamp?.text.link?.url).toBe(timestampUrl(gwagon.metadata.ref, sec));
      expect(stamp?.text.content).toMatch(/^\d+:\d{2}$/);
      text.push(words.map((w) => w.text.content).join(''));
    }
    expect(text.join(' ').replace(/\s+/g, ' ').trim()).toBe(segmentsToText(gwagon.transcript.segments));
  });

  it('fits one request for a short page and keeps the batches in order', async () => {
    const plan = await planNotionPage(gwagon);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches.flat()).toEqual(plan.blocks);
    checkLimits(plan.batches);
  });

  it('splits a long page into ordered batches of at most 100 blocks', async () => {
    // One paragraph per caption line gives 500+ blocks from the real 18-minute transcript.
    const plan = await planNotionPage(gwagon, { layout: { softSec: 0, hardSec: 0 } });
    expect(plan.blocks.length).toBeGreaterThan(500);
    expect(plan.batches.length).toBe(Math.ceil(plan.blocks.length / NOTION_CHILDREN_LIMIT));
    expect(plan.batches.slice(0, -1).every((b) => b.length === NOTION_CHILDREN_LIMIT)).toBe(true);
    expect(plan.batches.flat()).toEqual(plan.blocks);
    expect(plan.batches[0]?.[0]?.type).toBe('paragraph');
    expect(parseMarker(plain(plan.batches[0]?.[0] as NotionBlock))?.id).toBe('youtube:cCPsdFdlshc');
    checkLimits(plan.batches);
  });

  it('adds a summary callout only when a brief exists, and the digest follows the content', async () => {
    const brief = segmentsToText(zoo.transcript.segments);
    const plain1 = await planNotionPage(zoo);
    const again = await planNotionPage(zoo);
    const withBrief = await planNotionPage(zoo, { briefs: { 'youtube:jNQXAC9IVRw': brief } });
    expect(again.digest).toBe(plain1.digest);
    expect(withBrief.digest).not.toBe(plain1.digest);
    const callout = withBrief.blocks.find((b) => b.type === 'callout');
    expect(callout && plain(callout)).toBe(`Summary\n${brief}`);
  });

  it('ends with a Comments heading and one bullet per comment, replies nested, only when comments exist', async () => {
    expect((await planNotionPage(zoo)).blocks.some((b) => b.type === 'bulleted_list_item')).toBe(false);
    const plan = await planNotionPage(withComments);
    const heading = plan.blocks.findIndex((b) => b.type === 'heading_2' && plain(b) === 'Comments');
    expect(heading).toBeGreaterThan(0);
    const bullets = plan.blocks.slice(heading + 1);
    expect(bullets.map((b) => b.type)).toEqual(comments.map(() => 'bulleted_list_item'));
    const [pinned] = bullets;
    expect(body(pinned as NotionBlock).rich_text?.[0]).toMatchObject({
      text: { content: '@SanDiegoZoo' },
      annotations: { bold: true },
    });
    expect(plain(pinned as NotionBlock)).toBe(
      "@SanDiegoZoo (pinned, 4800000 likes): We're so honored that the first ever YouTube video was filmed here!",
    );
    expect((body(pinned as NotionBlock).children ?? []).map(plain)).toEqual(
      (comments[0]?.replies ?? []).map((r) => `${r.author} (${r.likes} likes): ${r.text}`),
    );
    expect(plan.digest).not.toBe((await planNotionPage(zoo)).digest);
    checkLimits(plan.batches);
  });
});

describe('text and batching helpers', () => {
  it('splits long text at whitespace into pieces within the limit without losing characters', () => {
    const text = segmentsToText(gwagon.transcript.segments);
    expect(text.length).toBeGreaterThan(10_000);
    const parts = splitText(text);
    expect(parts.every((p) => p.length <= NOTION_TEXT_LIMIT)).toBe(true);
    expect(parts.join('')).toBe(text);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(richText(text).map((r) => r.text.content)).toEqual(parts);
  });

  it('never splits a surrogate pair', () => {
    const parts = splitText('\u{1F600}'.repeat(1500));
    expect(parts.every((p) => p.length <= NOTION_TEXT_LIMIT && !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
    expect(parts.join('')).toBe('\u{1F600}'.repeat(1500));
  });

  it('drops links Notion would reject', () => {
    expect(richText('0:01', { link: 'file:///tmp/a.mp3' })[0]?.text.link).toBeUndefined();
    expect(
      richText('0:01', { link: `https://www.youtube.com/watch?v=jNQXAC9IVRw&x=${'a'.repeat(2000)}` })[0]?.text.link,
    ).toBeUndefined();
  });

  it('cuts batches by the 1000-element limit when blocks carry children', async () => {
    const plan = await planNotionPage(zoo);
    const toggle = plan.blocks.find((b) => b.type === 'toggle') as NotionBlock;
    const n = elementCount(toggle);
    expect(n).toBeGreaterThan(1);
    const batches = batchBlocks(Array.from({ length: 99 }, () => toggle));
    for (const b of batches) expect(b.reduce((s, x) => s + elementCount(x), 0)).toBeLessThanOrEqual(NOTION_ELEMENTS_LIMIT);
    expect(batches.flat()).toHaveLength(99);
  });
});

describe('configuration', () => {
  it('accepts page ids with or without dashes and page URLs', () => {
    expect(notionId(DOCS_PAGE_ID)).toBe(DOCS_PAGE_ID);
    expect(notionId(DOCS_PAGE_ID.replace(/-/g, ''))).toBe(DOCS_PAGE_ID);
    expect(notionId(`https://www.notion.so/workspace/Research-${DOCS_PAGE_ID.replace(/-/g, '')}?pvs=4`)).toBe(DOCS_PAGE_ID);
    expect(notionId('Research')).toBeUndefined();
    expect(notionUrl(DOCS_PAGE_ID)).toBe(`https://www.notion.so/${DOCS_PAGE_ID.replace(/-/g, '')}`);
  });

  it('reads the token and parent page from ctx.env, never process.env', () => {
    const ctx = testContext({ env: { NOTION_TOKEN: 'from-env', NOTION_PARENT_PAGE_ID: DOCS_PAGE_ID } });
    expect(notionConfig({}, ctx)).toEqual({ token: 'from-env', parentId: DOCS_PAGE_ID });
    expect(notionConfig({ token: 'given' }, ctx).token).toBe('given');
  });

  it('explains a missing token, a missing parent and a bad parent before any request', async () => {
    const fetch = replayFetch([]);
    await expect(exportNotion([zoo], {}, testContext({ fetch }))).rejects.toMatchObject({
      code: 'no-provider',
      message: 'NOTION_TOKEN is not set.',
    });
    await expect(exportNotion([zoo], {}, testContext({ fetch, env: { NOTION_TOKEN: 'x' } }))).rejects.toMatchObject({
      code: 'bad-request',
    });
    await expect(
      exportNotion([zoo], { parentPageId: 'Research' }, testContext({ fetch, env: { NOTION_TOKEN: 'x' } })),
    ).rejects.toMatchObject({
      code: 'bad-request',
    });
    expect(fetch.calls).toHaveLength(0);
  });
});
