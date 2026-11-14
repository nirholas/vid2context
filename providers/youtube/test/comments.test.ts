import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, getVideoContext, type Logger, Registry, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type RecordedCall, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { commentSettings, getYouTubeComments, pickReplyThreads, selectReplies } from '../src/comments/index.ts';
import {
  findCommentSection,
  findSortTokens,
  type Json,
  parseCommentsPage,
  parseCount,
  parseRepliesPage,
  relativeToIso,
} from '../src/comments/parse.ts';
import { youtubeCaptions, youtubeSource } from '../src/index.ts';
import { matchYouTube } from '../src/url.ts';

// Fixtures are real recordings, trimmed (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const fx = (name: string) => JSON.parse(fixture(name)) as Json;
const hasFixture = (name: string) => existsSync(join(import.meta.dirname, 'fixtures', name));

const VID = 'Pqdv2ql971M';
/** When the fixtures were recorded; relative dates are resolved against it. */
const RECORDED = Date.parse('2026-11-14T17:03:00Z');

const ref = (input: string): VideoRef => {
  const r = matchYouTube(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
};

/** continuation token -> the fixture file that token returned when recorded. */
function tokenFixtures(): Map<string, string> {
  const map = new Map<string, string>();
  const add = (token: string | undefined, file: string) => {
    if (token) map.set(token, file);
  };
  const next = fx(`next-${VID}.json`);
  add(findCommentSection(next).token, `comments-${VID}-top-1.json`);
  add(findSortTokens(next).newest, `comments-${VID}-newest-1.json`);
  const page1 = parseCommentsPage(fx(`comments-${VID}-top-1.json`));
  add(page1.next, `comments-${VID}-top-2.json`);
  add(parseCommentsPage(fx(`comments-${VID}-top-2.json`)).next, `comments-${VID}-top-3.json`);
  for (const t of page1.threads) {
    const file = `replies-${VID}-${t.comment.id}.json`;
    if (hasFixture(file)) add(t.replyToken, file);
  }
  return map;
}

const VIDEOS: Record<string, string> = {
  [VID]: `next-${VID}.json`,
  XqZsoesa55w: 'next-XqZsoesa55w.json',
  xxxxxxxxxxx: 'next-xxxxxxxxxxx.json',
};

function commentsReplay(hook?: (file: string) => void) {
  const tokens = tokenFixtures();
  return replayFetch([
    {
      method: 'POST',
      url: /youtubei\/v1\/next\?/,
      response: (call: RecordedCall) => {
        const body = JSON.parse(String(call.body)) as { videoId?: string; continuation?: string };
        const file = body.videoId ? VIDEOS[body.videoId] : tokens.get(body.continuation ?? '');
        if (!file) throw new Error(`no recorded next response for ${String(call.body).slice(0, 200)}`);
        hook?.(file);
        return { body: fixture(file), headers: { 'content-type': 'application/json' } };
      },
    },
    {
      method: 'POST',
      url: /youtubei\/v1\/player\?/,
      response: { body: fixture('player-unavailable.json'), headers: { 'content-type': 'application/json' } },
    },
  ]);
}

function capturingLog() {
  const lines: { level: string; msg: string }[] = [];
  const at = (level: string) => (msg: string) => {
    lines.push({ level, msg });
  };
  const log: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  return { log, lines };
}

const nextBodies = (calls: RecordedCall[]) =>
  calls.filter((c) => c.url.includes('/next')).map((c) => JSON.parse(String(c.body)) as Record<string, unknown>);

describe('parseCount', () => {
  it.each([
    ['987', 987],
    ['1.2K', 1200],
    ['3M', 3_000_000],
    ['2.5B', 2_500_000_000],
    ['1,234', 1234],
    ['15k', 15_000],
    [' ', 0],
    ['', 0],
  ])('%j -> %d', (text, n) => {
    expect(parseCount(text)).toBe(n);
  });

  it('returns undefined for text that is not a count', () => {
    expect(parseCount('many')).toBeUndefined();
    expect(parseCount(undefined)).toBeUndefined();
  });
});

describe('relativeToIso', () => {
  it('gives a date only for day-or-longer units, so it never claims more precision than YouTube shows', () => {
    expect(relativeToIso('1 year ago', RECORDED)).toBe('2025-11-14');
    expect(relativeToIso('2 years ago', RECORDED)).toBe('2024-11-14');
    expect(relativeToIso('10 months ago (edited)', RECORDED)).toBe('2026-01-18');
    expect(relativeToIso('3 weeks ago', RECORDED)).toBe('2026-10-24');
    expect(relativeToIso('1 day ago', RECORDED)).toBe('2026-11-13');
  });

  it('keeps a timestamp for hours, minutes and seconds', () => {
    expect(relativeToIso('5 hours ago', RECORDED)).toBe('2026-11-14T12:03:00.000Z');
    expect(relativeToIso('1 minute ago', RECORDED)).toBe('2026-11-14T17:02:00.000Z');
  });

  it('returns undefined for text it cannot read', () => {
    expect(relativeToIso('Streamed live', RECORDED)).toBeUndefined();
    expect(relativeToIso(undefined, RECORDED)).toBeUndefined();
  });
});

describe('comment parsers on recorded responses', () => {
  it('finds the comments section and the sort menu in the next response', () => {
    const next = fx(`next-${VID}.json`);
    const section = findCommentSection(next);
    expect(section.found).toBe(true);
    expect(section.token).toMatch(/^Eg0SC1BxZHYycWw5NzFN/);
    const sort = findSortTokens(next);
    expect(sort.top).toBeTruthy();
    expect(sort.newest).toBeTruthy();
    expect(sort.newest).not.toBe(sort.top);
  });

  it('reports the message when comments are turned off', () => {
    expect(findCommentSection(fx('next-XqZsoesa55w.json'))).toEqual({ found: true, message: 'Comments are turned off.' });
    expect(findCommentSection(fx('next-xxxxxxxxxxx.json'))).toEqual({ found: false });
  });

  it('maps every field of the entity shape (WEB)', () => {
    const page = parseCommentsPage(fx(`comments-${VID}-top-1.json`), RECORDED);
    expect(page.threads).toHaveLength(20);
    expect(page.next).toBeTruthy();
    const [pinned] = page.threads;
    expect(pinned.comment).toMatchObject({
      id: 'UgyrP_RTBJnbXD9X4el4AaABAg',
      author: '@Jimports',
      likes: 28,
      publishedAt: '2025-11-14',
      isCreator: true,
      isPinned: true,
    });
    expect(pinned.comment.text.startsWith('If you’re thinking about buying a G-Wagen')).toBe(true);
    expect(pinned.replyCount).toBe(7);
    expect(pinned.replyToken).toBeTruthy();

    const byId = new Map(page.threads.map((t) => [t.comment.id, t]));
    // A single space is how WEB shows zero likes.
    expect(byId.get('UgxKnwr-_ML7-NYmj_94AaABAg')?.comment).toMatchObject({ likes: 0, publishedAt: '2026-10-24' });
    expect(byId.get('UgxKnwr-_ML7-NYmj_94AaABAg')?.comment.isCreator).toBeUndefined();
    expect(byId.get('UgxKnwr-_ML7-NYmj_94AaABAg')?.comment.isPinned).toBeUndefined();
    // Threads the creator replied in are marked.
    const creatorReplied = page.threads.filter((t) => t.creatorReplied).map((t) => t.comment.id);
    expect(creatorReplied).toEqual(['UgzGZBoXBL089a7jFep4AaABAg', 'Ugyl6uaO_N4qYI2EQyF4AaABAg', 'UgzLMAb8KLE1iM6FVDJ4AaABAg']);
    // Timestamps in text stay as text.
    expect(byId.get('UgySPj15C-ZGA239kv94AaABAg')?.comment.text).toContain('6:38');
  });

  it('keeps emoji as characters', () => {
    const page = parseCommentsPage(fx(`comments-${VID}-top-3.json`), RECORDED);
    const texts = page.threads.map((t) => t.comment.text);
    expect(texts).toContain('I wanna invest in this channel \u{1F923}');
  });

  it('maps the renderer shape (MWEB) to the same values as the entity shape', () => {
    const web = parseCommentsPage(fx(`comments-${VID}-top-1.json`), RECORDED).threads;
    const mweb = parseCommentsPage(fx(`comments-${VID}-mweb-1.json`), RECORDED).threads;
    expect(mweb).toHaveLength(20);
    expect(mweb[0].comment).toMatchObject({ id: 'UgyrP_RTBJnbXD9X4el4AaABAg', isPinned: true, isCreator: true, likes: 28 });
    const webById = new Map(web.map((t) => [t.comment.id, t]));
    let compared = 0;
    for (const t of mweb) {
      const w = webById.get(t.comment.id);
      if (!w) continue;
      compared++;
      expect(t.comment).toEqual(w.comment);
      expect(t.replyCount).toBe(w.replyCount);
    }
    expect(compared).toBeGreaterThanOrEqual(15);
  });

  it('keeps links as full URLs in both shapes', () => {
    for (const file of ['comments-gqYNyRIGYOQ-top-1.json', 'comments-gqYNyRIGYOQ-mweb-1.json']) {
      const [thread] = parseCommentsPage(fx(file), RECORDED).threads;
      expect(thread.comment.text).toBe("Here's the link! \n\nhttps://tinyurl.com/532k6byv");
      expect(thread.comment.isCreator).toBe(true);
    }
  });

  it('parses reply pages, flags creator replies and drops zero-width spaces', () => {
    const { replies, next } = parseRepliesPage(fx(`replies-${VID}-Ugyl6uaO_N4qYI2EQyF4AaABAg.json`), RECORDED);
    expect(next).toBeUndefined();
    expect(replies.map((r) => [r.author, r.isCreator === true, r.likes])).toEqual([
      ['@Jimports', true, 6],
      ['@NVSTRZ34', false, 5],
      ['@Jimports', true, 9],
    ]);
    expect(replies[1].text.startsWith('@Jimports')).toBe(true);
    expect(replies[0].id).toBe('Ugyl6uaO_N4qYI2EQyF4AaABAg.AJ6a8wcLOthAJ6w1ZFWFGT');
  });
});

describe('reply selection', () => {
  const page = () => parseCommentsPage(fx(`comments-${VID}-top-1.json`), RECORDED).threads;

  it('expands creator-replied threads first, then the most liked', () => {
    expect(pickReplyThreads(page()).map((t) => t.comment.id)).toEqual([
      'UgzGZBoXBL089a7jFep4AaABAg',
      'Ugyl6uaO_N4qYI2EQyF4AaABAg',
      'UgzLMAb8KLE1iM6FVDJ4AaABAg',
      'UgyrP_RTBJnbXD9X4el4AaABAg',
      'UgxdCXY4cjxFeKYcGaZ4AaABAg',
      'UgwePcmbQMWpAP-KFpV4AaABAg',
    ]);
  });

  it('caps replies per thread and always keeps a creator reply', () => {
    const replies = parseRepliesPage(fx(`replies-${VID}-UgzGZBoXBL089a7jFep4AaABAg.json`), RECORDED).replies;
    expect(replies.map((r) => r.author)).toEqual(['@Jimports', '@Valueshooter', '@Mr.Cheerios']);
    expect(selectReplies(replies, 1).map((r) => r.author)).toEqual(['@Jimports']);
    expect(selectReplies(replies, 2).map((r) => r.author)).toEqual(['@Jimports', '@Valueshooter']);
    const creatorLast = [...replies].reverse();
    expect(selectReplies(creatorLast, 1).map((r) => r.author)).toEqual(['@Jimports']);
    expect(selectReplies(creatorLast, 2).map((r) => r.author)).toEqual(['@Mr.Cheerios', '@Jimports']);
  });
});

describe('commentSettings', () => {
  it('applies defaults, bounds and env', () => {
    expect(commentSettings({}, {})).toEqual({ limit: 50, sort: 'top', replies: 5 });
    expect(commentSettings({ limit: 9000 }, { YOUTUBE_COMMENT_REPLIES: '0' })).toEqual({ limit: 500, sort: 'top', replies: 0 });
    expect(commentSettings({ limit: 0 }, { YOUTUBE_COMMENTS_SORT: 'Newest' })).toEqual({ limit: 1, sort: 'newest', replies: 5 });
    expect(commentSettings({ sort: 'top' }, { YOUTUBE_COMMENTS_SORT: 'newest' }).sort).toBe('top');
  });

  it('rejects bad env values with a hint', () => {
    expect(() => commentSettings({}, { YOUTUBE_COMMENT_REPLIES: 'lots' })).toThrow(Vid2ContextError);
    expect(() => commentSettings({}, { YOUTUBE_COMMENTS_SORT: 'oldest' })).toThrow(/Unknown YouTube comment sort/);
  });
});

describe('getYouTubeComments (replayed)', () => {
  const video = ref(`https://www.youtube.com/watch?v=${VID}`);

  it('returns 20 comments with the pinned creator comment first and bounded replies', async () => {
    const fetch = commentsReplay();
    const comments = await getYouTubeComments(video, testContext({ fetch }), { limit: 20 });
    expect(comments).toHaveLength(20);
    expect(comments[0]).toMatchObject({ author: '@Jimports', isPinned: true, isCreator: true });
    // next + one page + one reply page for each of the 6 picked threads.
    expect(fetch.calls).toHaveLength(8);
    expect(comments[0].replies).toHaveLength(5);
    const withCreatorReply = comments.find((c) => c.id === 'UgzGZBoXBL089a7jFep4AaABAg');
    expect(withCreatorReply?.replies?.[0]).toMatchObject({ author: '@Jimports', isCreator: true, text: 'ty bby' });
    expect(comments.filter((c) => c.replies).length).toBe(6);
  });

  it('stops paging as soon as the limit is met', async () => {
    const env = { YOUTUBE_COMMENT_REPLIES: '0' };
    for (const [limit, requests] of [
      [5, 2],
      [20, 2],
      [25, 3],
      [50, 4],
    ] as const) {
      const fetch = commentsReplay();
      const comments = await getYouTubeComments(video, testContext({ fetch, env }), { limit });
      expect(comments).toHaveLength(limit);
      expect(fetch.calls).toHaveLength(requests);
    }
  });

  it('defaults to 50 comments', async () => {
    const fetch = commentsReplay();
    const comments = await getYouTubeComments(video, testContext({ fetch, env: { YOUTUBE_COMMENT_REPLIES: '0' } }));
    expect(comments).toHaveLength(50);
    expect(new Set(comments.map((c) => c.id)).size).toBe(50);
  });

  it('uses the Newest sort from opts or YOUTUBE_COMMENTS_SORT', async () => {
    for (const [opts, env] of [
      [{ limit: 10, sort: 'newest' as const }, { YOUTUBE_COMMENT_REPLIES: '0' }],
      [{ limit: 10 }, { YOUTUBE_COMMENT_REPLIES: '0', YOUTUBE_COMMENTS_SORT: 'newest' }],
    ] as const) {
      const fetch = commentsReplay();
      const comments = await getYouTubeComments(video, testContext({ fetch, env }), opts);
      expect(comments.slice(0, 3).map((c) => c.author)).toEqual(['@Jimports', '@romanmuradyan220', '@HelloAutoCarz']);
      expect(nextBodies(fetch.calls)[1].continuation).toBe(findSortTokens(fx(`next-${VID}.json`)).newest);
    }
  });

  it('returns [] and logs the reason when comments are turned off', async () => {
    const fetch = commentsReplay();
    const { log, lines } = capturingLog();
    const ctx = createContext({ runtime: 'node', env: {}, fetch, log });
    expect(await getYouTubeComments(ref('https://youtu.be/XqZsoesa55w'), ctx)).toEqual([]);
    expect(fetch.calls).toHaveLength(1);
    expect(lines).toEqual([{ level: 'info', msg: 'YouTube XqZsoesa55w: no comments (Comments are turned off.)' }]);
  });

  it('throws for an unavailable video', async () => {
    const fetch = commentsReplay();
    await expect(getYouTubeComments(ref('xxxxxxxxxxx'), testContext({ fetch }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects inputs that are not a single video', async () => {
    const list = ref('https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b');
    await expect(getYouTubeComments(list, testContext())).rejects.toMatchObject({ code: 'unsupported-input' });
  });

  it('honours ctx.signal between pages', async () => {
    const controller = new AbortController();
    const fetch = commentsReplay((file) => {
      if (file.endsWith('top-1.json')) controller.abort();
    });
    const ctx = testContext({ fetch, signal: controller.signal, env: { YOUTUBE_COMMENT_REPLIES: '0' } });
    await expect(getYouTubeComments(video, ctx, { limit: 50 })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(2);
  });

  it('is wired into the YouTube source', async () => {
    const fetch = commentsReplay();
    const comments = await youtubeSource.getComments?.(video, testContext({ fetch, env: { YOUTUBE_COMMENT_REPLIES: '0' } }), {
      limit: 3,
    });
    expect(comments?.map((c) => c.id)).toEqual([
      'UgyrP_RTBJnbXD9X4el4AaABAg',
      'UgzGZBoXBL089a7jFep4AaABAg',
      'Ugyl6uaO_N4qYI2EQyF4AaABAg',
    ]);
  });
});

describe.skipIf(!process.env.LIVE)('youtube comments (live)', () => {
  it('returns 20 top comments with the pinned creator comment first, through the pipeline', async () => {
    const ctx = createContext({ runtime: 'node', env: process.env });
    const registry = new Registry([youtubeSource, youtubeCaptions], 'node');
    const context = await getVideoContext(registry, `https://www.youtube.com/watch?v=${VID}`, { comments: 20 }, ctx);
    const comments = context.comments ?? [];
    expect(comments).toHaveLength(20);
    expect(comments[0]).toMatchObject({ author: '@Jimports', isPinned: true, isCreator: true });
    expect(comments.some((c) => c.replies?.some((r) => r.isCreator))).toBe(true);
  }, 60_000);
});
