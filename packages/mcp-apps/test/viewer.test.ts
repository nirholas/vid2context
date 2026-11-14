// @vitest-environment happy-dom
/**
 * Renders the viewer against real VideoContext output of the pipeline
 * (tests/fixtures/contexts) in a DOM environment.
 */
import { readFileSync } from 'node:fs';
import type { VideoContext } from '@vid2context/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { toViewerData, type ViewerData } from '../src/data.ts';
import { createViewer, MAX_RENDERED_LINES, type Viewer } from '../src/ui/viewer.ts';

const load = (file: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8')) as VideoContext;

const long = load('youtube-cCPsdFdlshc.json');
const zoo = load('youtube-jNQXAC9IVRw.json');
const TITLE = 'Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!';

function mount(context: VideoContext): { viewer: Viewer; data: ViewerData; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const viewer = createViewer(root);
  const data = toViewerData(context);
  viewer.setData(data);
  return { viewer, data, root };
}

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.row')];
const rowIndex = (el: Element | null) => Number((el as HTMLElement | null)?.dataset.i);

/** How often `word` occurs in the raw fixture text, counted independently of the viewer. */
function occurrences(context: VideoContext, word: string): number {
  let n = 0;
  for (const s of context.transcript.segments) {
    const t = s.text.toLowerCase();
    for (let i = t.indexOf(word); i !== -1; i = t.indexOf(word, i + word.length)) n++;
  }
  return n;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('transcript viewer', () => {
  it('shows the title, channel, duration and origin in the header', () => {
    const { root } = mount(long);
    expect(root.querySelector('h1')?.textContent).toBe(TITLE);
    expect(root.querySelector('.meta')?.textContent).toBe('Alliance Motorworks · 18:04 · auto captions, en · 521 lines');
  });

  it('windows a long transcript: only a bounded number of line elements exist', () => {
    const { viewer, root } = mount(long);
    expect(long.transcript.segments).toHaveLength(521);
    const first = rows(root);
    expect(first.length).toBeGreaterThan(5);
    expect(first.length).toBeLessThanOrEqual(MAX_RENDERED_LINES);
    expect(rowIndex(first[0] ?? null)).toBe(0);

    viewer.focusLine(520);
    const end = rows(root);
    expect(end.length).toBeLessThanOrEqual(MAX_RENDERED_LINES);
    expect(end.some((r) => r.dataset.i === '520')).toBe(true);
    expect(end.some((r) => r.dataset.i === '0')).toBe(false);
    expect(rowIndex(document.activeElement)).toBe(520);
  });

  it('renders each line with [m:ss], a timestamp link and accessible controls', () => {
    const { root, data } = mount(long);
    const row = rows(root)[3] as HTMLElement;
    const seg = long.transcript.segments[3] as VideoContext['transcript']['segments'][number];
    const link = row.querySelector<HTMLAnchorElement>('a.ts');
    expect(link?.textContent).toBe('[0:04]');
    expect(link?.getAttribute('href')).toBe(`https://www.youtube.com/watch?v=cCPsdFdlshc&t=${Math.floor(seg.startSec)}s`);
    expect(link?.getAttribute('aria-label')).toBe('Open video at 0:04');
    expect(row.querySelector('.text')?.textContent).toBe(seg.text);
    expect(row.getAttribute('aria-posinset')).toBe('4');
    expect(row.getAttribute('aria-setsize')).toBe('521');
    expect(row.querySelector('input.sel')?.getAttribute('aria-label')).toBe('Select line at 0:04');
    expect(row.querySelector('button.cite')?.getAttribute('aria-label')).toBe('Copy citation for 0:04');
    expect(root.querySelector('[role="list"]')?.getAttribute('aria-label')).toBe(`Transcript of ${TITLE}, 521 lines`);
    expect(data.timestampBase).toBe('https://www.youtube.com/watch?v=cCPsdFdlshc&t={t}s');
  });

  it('finds every occurrence of a real word, highlights it and steps through hits', () => {
    const { viewer, root } = mount(long);
    const expected = occurrences(long, 'interior');
    expect(expected).toBeGreaterThan(1);
    expect(viewer.search('Interior')).toBe(expected);
    expect(root.querySelector('.count')?.textContent).toBe(`1 of ${expected}`);
    const firstLine = long.transcript.segments.findIndex((s) => s.text.toLowerCase().includes('interior'));
    const current = root.querySelector('mark.current');
    expect(current?.textContent?.toLowerCase()).toBe('interior');
    expect(rowIndex(current?.closest('.row') ?? null)).toBe(firstLine);

    viewer.nextMatch();
    expect(root.querySelector('.count')?.textContent).toBe(`2 of ${expected}`);
    viewer.prevMatch();
    viewer.prevMatch();
    expect(root.querySelector('.count')?.textContent).toBe(`${expected} of ${expected}`);
    const lastLine = long.transcript.segments.findLastIndex((s) => s.text.toLowerCase().includes('interior'));
    expect(rowIndex(root.querySelector('mark.current')?.closest('.row') ?? null)).toBe(lastLine);

    expect(viewer.search('zzqqxx')).toBe(0);
    expect(root.querySelector('.count')?.textContent).toBe('No matches');
    expect(root.querySelectorAll('mark')).toHaveLength(0);
  });

  it('runs the search from the input box and moves with Enter and Shift+Enter', () => {
    const { root } = mount(long);
    const input = root.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
    input.value = 'leather';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const total = occurrences(long, 'leather');
    expect(root.querySelector('.count')?.textContent).toBe(`1 of ${total}`);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(root.querySelector('.count')?.textContent).toBe(`2 of ${total}`);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(root.querySelector('.count')?.textContent).toBe(`1 of ${total}`);
  });

  it('lists chapters and jumps to the first line of the chosen one', () => {
    const { viewer, root } = mount(zoo);
    const chapters = [...root.querySelectorAll<HTMLButtonElement>('nav[aria-label="Chapters"] button')];
    expect(chapters.map((b) => b.textContent)).toEqual(['0:00Intro', '0:05The cool thing', '0:17End']);
    expect(chapters[1]?.getAttribute('aria-label')).toBe('Chapter 2: The cool thing, at 0:05');

    chapters[1]?.click();
    expect(rowIndex(document.activeElement)).toBe(1);
    expect(document.activeElement?.querySelector('.ts')?.textContent).toBe('[0:05]');
    expect(chapters[1]?.getAttribute('aria-current')).toBe('true');

    viewer.jumpToChapter(2);
    expect(rowIndex(document.activeElement)).toBe(5);
    expect(document.activeElement?.querySelector('.text')?.textContent).toBe("and that's pretty much all there is to say");
  });

  it('hides the chapter list when the video has none', () => {
    const { root } = mount(long);
    expect(root.querySelector<HTMLElement>('nav.chapters')?.hidden).toBe(true);
  });

  it('builds [Title @ m:ss](url) citations and copies them from the line button', async () => {
    const { viewer, root } = mount(long);
    const seg = long.transcript.segments[40] as VideoContext['transcript']['segments'][number];
    const ts = `${Math.floor(seg.startSec / 60)}:${String(Math.floor(seg.startSec % 60)).padStart(2, '0')}`;
    const expected = `[${TITLE} @ ${ts}](https://www.youtube.com/watch?v=cCPsdFdlshc&t=${Math.floor(seg.startSec)}s)`;
    expect(viewer.citationFor(40)).toBe(expected);

    viewer.focusLine(40);
    const row = rows(root).find((r) => r.dataset.i === '40') as HTMLElement;
    row.querySelector<HTMLButtonElement>('button.cite')?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(await navigator.clipboard.readText()).toBe(expected);
    expect(root.querySelector('.toast')?.textContent).toBe('Citation copied');
  });

  it('cites a local file without a link', () => {
    const local = { ...zoo, metadata: { ...zoo.metadata, ref: { ...zoo.metadata.ref, platform: 'file', url: undefined } } };
    const { viewer } = mount(local);
    expect(viewer.citationFor(2)).toBe('[Me at the zoo @ 0:07]');
  });

  it('selects a range and builds the message that "send to chat" posts', () => {
    const { viewer, root } = mount(long);
    viewer.selectRange(10, 12);
    const bar = root.querySelector<HTMLElement>('.selbar') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('.sel-label')?.textContent).toMatch(/^3 lines, \d+:\d\d to \d+:\d\d$/);
    const msg = viewer.selectionMessage();
    const lines = long.transcript.segments.slice(10, 13).map((s) => s.text.trim());
    expect(msg.startsWith(`From "${TITLE}" (Alliance Motorworks), `)).toBe(true);
    for (const l of lines) expect(msg).toContain(l);
    expect(msg.endsWith(`Source: ${viewer.citationFor(10)}`)).toBe(true);
    expect(rows(root).filter((r) => r.classList.contains('selected'))).toHaveLength(3);
    viewer.clearSelection();
    expect(bar.hidden).toBe(true);
  });

  it('moves between lines with the keyboard and keeps one tab stop', () => {
    const { viewer, root } = mount(long);
    viewer.focusLine(5);
    const row = document.activeElement as HTMLElement;
    expect(rowIndex(row)).toBe(5);
    expect(rows(root).filter((r) => r.tabIndex === 0)).toHaveLength(1);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(rowIndex(document.activeElement)).toBe(6);
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(rowIndex(document.activeElement)).toBe(520);
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(rowIndex(document.activeElement)).toBe(0);
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }),
    );
    expect(root.querySelector('.sel-label')?.textContent).toMatch(/^2 lines, /);
    expect(rows(root).filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it('shows host errors in place of the transcript', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const viewer = createViewer(root);
    expect(root.querySelector('.notice')?.textContent).toBe('Waiting for the transcript.');
    viewer.showError('No captions found.');
    expect(root.querySelector('.notice')?.textContent).toBe('No captions found.');
    expect(root.querySelector('.notice')?.classList.contains('error')).toBe(true);
  });
});
