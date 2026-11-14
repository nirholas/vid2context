/**
 * Live Notion export. Runs only with LIVE=1, NOTION_TOKEN and
 * NOTION_PARENT_PAGE_ID set (a page shared with the integration). It writes
 * real pages under that parent: run it against a scratch page.
 */
import { readFileSync } from 'node:fs';
import { createContext, type VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { exportNotion } from '../src/notion.ts';

const fixture = (name: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${name}.json`, import.meta.url), 'utf8')) as VideoContext;

const enabled = Boolean(process.env.LIVE && process.env.NOTION_TOKEN && process.env.NOTION_PARENT_PAGE_ID);

describe.skipIf(!enabled)('Notion export (live)', () => {
  const ctx = createContext({ runtime: 'node', env: process.env });

  it('creates a page per video, then recognises it instead of duplicating', async () => {
    const contexts = [fixture('youtube-jNQXAC9IVRw'), fixture('youtube-cCPsdFdlshc')];
    const first = await exportNotion(contexts, {}, ctx);
    expect(first.map((p) => p.videoId)).toEqual(['youtube:jNQXAC9IVRw', 'youtube:cCPsdFdlshc']);
    for (const p of first) expect(p.url).toMatch(/^https:\/\/www\.notion\.so\//);
    const second = await exportNotion(contexts, {}, ctx);
    expect(second.map((p) => p.pageId)).toEqual(first.map((p) => p.pageId));
    expect(second.map((p) => p.status)).toEqual(['unchanged', 'unchanged']);
  }, 300_000);

  it('rewrites a page in place when its content changes', async () => {
    const zoo = fixture('youtube-jNQXAC9IVRw');
    const before = await exportNotion([zoo], {}, ctx);
    const after = await exportNotion([zoo], { layout: { softSec: 0, hardSec: 0 } }, ctx);
    expect(after[0]?.pageId).toBe(before[0]?.pageId);
    expect(after[0]?.status).toBe('updated');
    await exportNotion([zoo], {}, ctx);
  }, 300_000);
});
