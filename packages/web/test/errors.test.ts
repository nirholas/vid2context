// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VideoContext } from '@vid2context/core';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptsTimeline } from '../src/components/AttemptsTimeline.tsx';
import { ErrorPanel } from '../src/components/ErrorPanel.tsx';
import { getContext } from '../src/lib/api.ts';
import type { AppError } from '../src/lib/errors.ts';
import { BASE, recorded, replay } from './helpers.ts';

afterEach(cleanup);

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected the call to fail');
}

describe('AttemptsTimeline', () => {
  it('lists every attempt in order with stage, id, outcome, reason, detail and time', () => {
    const context = recorded('context-jNQXAC9IVRw.json').body as VideoContext;
    render(createElement(AttemptsTimeline, { attempts: context.attempts }));
    const items = within(screen.getByRole('list', { name: 'Steps tried, in order' })).getAllByRole('listitem');
    expect(items).toHaveLength(context.attempts.length);
    expect(items.map((li) => li.getAttribute('data-outcome'))).toEqual(context.attempts.map((a) => a.outcome));
    const blocked = items[2] as HTMLElement;
    expect(blocked.textContent).toContain('Captions');
    expect(blocked.textContent).toContain('youtube-captions');
    expect(blocked.textContent).toContain('failed: blocked');
    expect(blocked.textContent).toContain('HTTP 429');
    expect(blocked.textContent).toContain('431 ms');
    expect(items.at(-1)?.textContent).toContain('Speech-to-text');
    expect(items.at(-1)?.textContent).toContain('worked');
  });

  it('says plainly when nothing ran', () => {
    render(createElement(AttemptsTimeline, { attempts: [] }));
    expect(screen.getByText('No provider ran before this stopped.')).toBeTruthy();
  });
});

describe('ErrorPanel', () => {
  it('shows the message, the hint, the code and what was tried for a real 404', async () => {
    const err = await rejection(
      getContext('https://www.youtube.com/watch?v=xxxxxxxxxxx', {}, { base: BASE, fetch: replay('context-not-found.json') }),
    );
    expect(err.code).toBe('not-found');
    expect(err.status).toBe(404);
    expect(err.attempts).toHaveLength(2);
    let retried = 0;
    render(createElement(ErrorPanel, { error: err, onRetry: () => retried++, showSettings: true }));
    const panel = screen.getByRole('alert');
    expect(within(panel).getByTestId('error-message').textContent).toBe('YouTube xxxxxxxxxxx: ERROR (This video is unavailable)');
    expect(within(panel).getByTestId('error-hint').textContent).toBe(
      'How to fix it: The video does not exist or was removed. Check the video id or URL.',
    );
    expect(panel.textContent).toContain('Error code not-found');
    expect(within(panel).getByText('What was tried (2)')).toBeTruthy();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(retried).toBe(1);
    expect(within(panel).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      `${import.meta.env.BASE_URL}?view=settings`,
    );
  });

  it('explains an unreachable API with a hint, never a bare failure', async () => {
    const err = await rejection(getContext('jNQXAC9IVRw', {}, { base: BASE, fetch: replay() }));
    render(createElement(ErrorPanel, { error: err }));
    expect(screen.getByTestId('error-message').textContent).toBe(`Could not reach the vid2context API at ${BASE}.`);
    expect(screen.getByTestId('error-hint').textContent).toContain('npm run start:server');
  });

  it('turns anything thrown into an error with a hint', () => {
    render(createElement(ErrorPanel, { error: new TypeError('x is undefined') }));
    expect(screen.getByTestId('error-message').textContent).toBe('x is undefined');
    expect(screen.getByTestId('error-hint').textContent).toContain('Reload the page');
  });
});
