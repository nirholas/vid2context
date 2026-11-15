/**
 * Podcasting 2.0 JSON chapters (`podcast:chapters`, application/json+chapters):
 * `{ "version": "1.2.0", "chapters": [{ "startTime": 0, "title": "...", "endTime"?, "toc"? }] }`.
 * Chapters with `toc: false` are silent markers (images, links) and are left out.
 */
import { type Chapter, type Ctx, errorFromResponse, fetchWithTimeout } from '@vid2context/core';
import { USER_AGENT, withEnds } from './feed.ts';

interface JsonChapter {
  startTime?: number | string;
  endTime?: number | string;
  title?: string;
  toc?: boolean;
}

export function parseJsonChapters(raw: string, durationSec?: number): Chapter[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (data as { chapters?: unknown }).chapters;
  if (!Array.isArray(list)) return [];
  const out: Chapter[] = [];
  for (const c of list as JsonChapter[]) {
    if (c.toc === false) continue;
    const start = Number(c.startTime);
    const title = String(c.title ?? '').trim();
    if (!Number.isFinite(start) || start < 0 || !title) continue;
    const end = Number(c.endTime);
    out.push({ title, startSec: start, ...(Number.isFinite(end) && end > start ? { endSec: end } : {}) });
  }
  return withEnds(out, durationSec);
}

export async function fetchChapters(url: string, ctx: Ctx, durationSec?: number): Promise<Chapter[]> {
  const res = await fetchWithTimeout(ctx, url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } }, 20_000);
  if (!res.ok) throw await errorFromResponse(res, 'podcast chapters');
  return parseJsonChapters(await res.text(), durationSec);
}
