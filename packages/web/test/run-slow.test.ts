// @vitest-environment jsdom
/**
 * The waiting screen never leaves a slow run as a dead end: it shows the
 * server's progress, and after SLOW_AFTER_SEC offers other ways to get the
 * result while the run carries on.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Fetching, plainProgress, SLOW_AFTER_SEC } from '../src/components/RunView.tsx';

const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

afterEach(cleanup);

describe('Fetching', () => {
  it('shows the progress message and no alternatives while the run is young', () => {
    render(
      createElement(Fetching, {
        url: URL,
        startedAt: Date.now(),
        progress: 'stt',
        onImported: () => undefined,
      }),
    );
    expect(screen.getByTestId('run-progress').textContent).toBe('Transcribing the audio');
    expect(screen.queryByTestId('run-slow')).toBeNull();
  });

  it('offers other ways after the slow threshold, without stopping the run', async () => {
    render(
      createElement(Fetching, {
        url: URL,
        startedAt: Date.now() - (SLOW_AFTER_SEC + 1) * 1000,
        onImported: () => undefined,
      }),
    );
    const slow = screen.getByTestId('run-slow');
    expect(slow.textContent).toContain('Still working');
    expect(screen.getByRole('link', { name: 'Download the video or audio instead' }).getAttribute('href')).toContain(
      'view=download',
    );
    expect(screen.queryByTestId('import-panel')).toBeNull();
    await userEvent.click(screen.getByTestId('run-slow-ways'));
    expect(screen.getByTestId('import-panel')).toBeTruthy();
    // Cancel is still there: waiting stays a choice.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('does not offer imports for input that is not a link', () => {
    render(
      createElement(Fetching, {
        url: 'upload:ab12',
        startedAt: Date.now() - (SLOW_AFTER_SEC + 1) * 1000,
        onImported: () => undefined,
      }),
    );
    expect(screen.getByTestId('run-slow').textContent).toContain('Still working');
    expect(screen.queryByTestId('run-slow-ways')).toBeNull();
  });
});

describe('plainProgress', () => {
  it('turns job stages into plain words and passes other messages through', () => {
    expect(plainProgress('resolve: youtube:jNQXAC9IVRw')).toBe('Reading the link');
    expect(plainProgress('captions')).toBe('Looking for captions');
    expect(plainProgress('found 12 videos')).toBe('found 12 videos');
  });
});
