import { describe, expect, it } from 'vitest';
import { MENU_CONTEXTS, menuTarget } from '../src/background/menus.ts';
import { HISTORY_LIMIT, type HistoryItem, withItem } from '../src/lib/history.ts';
import { apiTranscriptLink, appLink, isWebUrl, originPattern, youtubeWatchId } from '../src/lib/links.ts';
import { applyTemplate, cleanBase, DEFAULT_SETTINGS, normalizeSettings } from '../src/lib/settings.ts';

const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

describe('settings', () => {
  it('has the documented defaults', () => {
    expect(normalizeSettings(undefined)).toEqual({
      appBase: 'https://vid2context.com',
      apiBase: 'http://localhost:8787/api/v1',
      copyFormat: 'agent',
      copyTemplate: '{{content}}',
      timestamps: true,
    });
  });

  it('cleans bases and drops malformed values', () => {
    expect(cleanBase(' https://example.org/app/ ')).toBe('https://example.org/app');
    expect(cleanBase('ftp://example.org')).toBeNull();
    expect(cleanBase('nope')).toBeNull();
    const s = normalizeSettings({
      appBase: 'javascript:alert(1)',
      apiBase: 'https://api.example.org/api/v1/',
      copyTemplate: 'no content',
      timestamps: 'yes',
    });
    expect(s.appBase).toBe(DEFAULT_SETTINGS.appBase);
    expect(s.apiBase).toBe('https://api.example.org/api/v1');
    expect(s.copyTemplate).toBe('{{content}}');
    expect(s.timestamps).toBe(true);
  });

  it('fills templates in one pass, leaving unknown placeholders and content braces alone', () => {
    expect(applyTemplate('{{ title }}: {{content}} {{other}}', { title: 'T', content: 'has {{title}}' })).toBe(
      'T: has {{title}} {{other}}',
    );
  });
});

describe('links', () => {
  it('builds the app hand-off and API links', () => {
    expect(appLink('https://vid2context.com', ZOO)).toBe(
      'https://vid2context.com/app/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw',
    );
    expect(apiTranscriptLink('http://localhost:8787/api/v1', ZOO, 'text', false)).toBe(
      'http://localhost:8787/api/v1/transcript?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw&format=text',
    );
  });

  it('turns a base into a host permission pattern without the port', () => {
    expect(originPattern('http://localhost:8787/api/v1')).toBe('http://localhost/*');
    expect(originPattern('https://vid2context.com/api/v1')).toBe('https://vid2context.com/*');
  });

  it('recognises watch pages only', () => {
    expect(youtubeWatchId(ZOO)).toBe('jNQXAC9IVRw');
    expect(youtubeWatchId('https://m.youtube.com/watch?v=jNQXAC9IVRw&t=5s')).toBe('jNQXAC9IVRw');
    expect(youtubeWatchId('https://www.youtube.com/shorts/jNQXAC9IVRw')).toBeNull();
    expect(youtubeWatchId('https://www.youtube.com/')).toBeNull();
    expect(youtubeWatchId('https://example.com/watch?v=jNQXAC9IVRw')).toBeNull();
    expect(isWebUrl('chrome://extensions')).toBe(false);
  });
});

describe('context menu target', () => {
  it('covers links, pages and video elements', () => {
    expect(MENU_CONTEXTS).toEqual(['link', 'page', 'video']);
  });

  it('prefers the link, then a real video source, then the page', () => {
    expect(menuTarget({ linkUrl: ZOO, pageUrl: 'https://news.ycombinator.com/' })).toBe(ZOO);
    expect(menuTarget({ mediaType: 'video', srcUrl: `blob:https://www.youtube.com/${'0'.repeat(8)}`, pageUrl: ZOO })).toBe(ZOO);
    expect(
      menuTarget({
        mediaType: 'video',
        srcUrl:
          'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.480p.vp9.webm',
        pageUrl: 'https://commons.wikimedia.org/',
      }),
    ).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
    expect(menuTarget({ pageUrl: 'chrome://newtab/' })).toBeNull();
  });
});

describe('history', () => {
  const item = (url: string, at: string): HistoryItem => ({ url, title: url, action: 'copy', at });

  it('keeps the newest entry per URL and at most five', () => {
    let list: HistoryItem[] = [];
    for (let i = 0; i < 7; i++)
      list = withItem(list, item(`https://www.youtube.com/watch?v=video${i}xxxx`, `2026-11-14T10:0${i}:00Z`));
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0]?.url).toContain('video6');
    list = withItem(list, item('https://www.youtube.com/watch?v=video3xxxx', '2026-11-14T11:00:00Z'));
    expect(list.map((i) => i.url.slice(-9, -4))).toEqual(['ideo3', 'ideo6', 'ideo5', 'ideo4', 'ideo2']);
  });
});
