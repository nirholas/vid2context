// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RecentList } from '../src/components/home/RecentList.tsx';
import { PLACEHOLDER, UrlForm } from '../src/components/home/UrlForm.tsx';
import { summarize } from '../src/lib/history.ts';
import { sharedContext } from './helpers.ts';

afterEach(cleanup);

describe('UrlForm', () => {
  it('submits the trimmed link with Enter', async () => {
    const submitted: string[] = [];
    render(createElement(UrlForm, { onSubmit: (u: string) => submitted.push(u) }));
    const input = screen.getByLabelText('Video link');
    expect(input.getAttribute('placeholder')).toBe(PLACEHOLDER);
    await userEvent.type(input, '  https://youtu.be/jNQXAC9IVRw {Enter}');
    expect(submitted).toEqual(['https://youtu.be/jNQXAC9IVRw']);
  });

  it('asks for a link instead of submitting an empty one', async () => {
    const submitted: string[] = [];
    render(createElement(UrlForm, { onSubmit: (u: string) => submitted.push(u) }));
    await userEvent.click(screen.getByRole('button', { name: 'Get context' }));
    expect(submitted).toEqual([]);
    expect(screen.getByRole('alert').textContent).toBe('Paste a link first.');
    expect(document.activeElement).toBe(screen.getByLabelText('Video link'));
  });
});

describe('RecentList', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const entries = [
    {
      ...summarize(sharedContext('youtube-cCPsdFdlshc'), { input: 'https://www.youtube.com/watch?v=cCPsdFdlshc' }, 13),
      savedAt: now - 3600_000,
    },
    { ...summarize(sharedContext('youtube-jNQXAC9IVRw'), { input: 'jNQXAC9IVRw', mode: 'stt' }, 12), savedAt: now - 120_000 },
  ].map(({ context: _c, ...s }) => s);

  it('shows title, file count and time ago, linking back to the run', () => {
    render(createElement(RecentList, { entries, total: 2, onClear: async () => undefined, now }));
    const items = within(screen.getByTestId('recent-list')).getAllByRole('link');
    expect(items[1]?.textContent).toContain('Me at the zoo');
    expect(items[1]?.textContent).toContain('12 files');
    expect(items[1]?.textContent).toContain('2 minutes ago');
    expect(items[1]?.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}?url=jNQXAC9IVRw&mode=stt`);
    expect(items[0]?.textContent).toContain('1 hour ago');
  });

  it('asks for confirmation inline before clearing', async () => {
    let cleared = 0;
    render(createElement(RecentList, { entries, total: 2, onClear: async () => void cleared++, now }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    expect(screen.getByText('Delete all 2 saved results from this browser?')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cleared).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(cleared).toBe(1);
  });
});
