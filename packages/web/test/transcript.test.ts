// @vitest-environment jsdom
import { timestampUrl } from '@vid2context/core';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { findMatches, segmentForChapter, TranscriptTab } from '../src/components/results/TranscriptTab.tsx';
import { sharedContext } from './helpers.ts';

afterEach(cleanup);

describe('TranscriptTab', () => {
  it('links every line to that moment in the source', () => {
    const context = sharedContext('youtube-jNQXAC9IVRw');
    render(createElement(TranscriptTab, { context }));
    const list = screen.getByTestId('transcript');
    const links = within(list).getAllByRole('link');
    expect(links).toHaveLength(context.transcript.segments.length);
    context.transcript.segments.forEach((s, i) => {
      expect(links[i]?.getAttribute('href')).toBe(timestampUrl(context.metadata.ref, s.startSec));
      expect(links[i]?.getAttribute('target')).toBe('_blank');
    });
    expect(links[0]?.getAttribute('href')).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s');
  });

  it('highlights search matches and steps through them', async () => {
    const user = userEvent.setup();
    const context = sharedContext('youtube-cCPsdFdlshc');
    const expected = context.transcript.segments.reduce((n, s) => n + (s.text.match(/g-wagon/gi)?.length ?? 0), 0);
    expect(expected).toBeGreaterThan(1);
    const { container } = render(createElement(TranscriptTab, { context }));
    await user.type(screen.getByLabelText('Search the transcript'), 'G-Wagon');
    expect(await screen.findByText(`1 of ${expected} matches`)).toBeTruthy();
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(expected);
    expect(marks[0]?.getAttribute('data-current')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByTestId('match-count').textContent).toBe(`2 of ${expected} matches`);
    expect(container.querySelectorAll('mark')[1]?.getAttribute('data-current')).toBe('true');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(screen.getByTestId('match-count').textContent).toBe(`1 of ${expected} matches`);
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    render(createElement(TranscriptTab, { context: sharedContext('youtube-jNQXAC9IVRw') }));
    await user.type(screen.getByLabelText('Search the transcript'), 'giraffe');
    expect(await screen.findByText('No matches')).toBeTruthy();
  });

  it('offers a jump list of the chapters', () => {
    const context = sharedContext('youtube-jNQXAC9IVRw');
    render(createElement(TranscriptTab, { context }));
    const nav = screen.getByRole('navigation', { name: 'Jump to chapter' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['0:00 Intro', '0:05 The cool thing', '0:17 End']);
    const second = context.metadata.chapters[1];
    if (!second) throw new Error('fixture has chapters');
    const i = segmentForChapter(context.transcript.segments, second);
    expect(context.transcript.segments[i]?.endSec).toBeGreaterThan(second.startSec);
  });

  it('findMatches is case-insensitive and treats the query literally', () => {
    const segs = sharedContext('youtube-jNQXAC9IVRw').transcript.segments;
    expect([...findMatches(segs, 'ELEPHANTS').keys()]).toHaveLength(1);
    expect(findMatches(segs, '.*').size).toBe(0);
    expect(findMatches(segs, '   ').size).toBe(0);
  });
});
