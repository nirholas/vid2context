// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ResultView } from '../src/components/results/ResultView.tsx';
import { fileText, resultBundle } from '../src/lib/bundle.ts';
import { formatBytes } from '../src/lib/format.ts';
import { sharedContext } from './helpers.ts';

afterEach(cleanup);

const createdAt = new Date('2026-11-14T16:00:00.000Z');

describe('ResultView files', () => {
  it('renders every file with its size, the zip count, and switches the viewer on click', async () => {
    const context = sharedContext('youtube-jNQXAC9IVRw');
    const bundle = await resultBundle([context], { createdAt });
    render(createElement(ResultView, { context, createdAt }));
    const list = await screen.findByTestId('file-list');
    const buttons = within(list).getAllByRole('button');
    expect(buttons).toHaveLength(bundle.files.length);
    const srt = bundle.files.find((f) => f.path === 'transcript.srt');
    const srtButton = within(list).getByRole('button', { name: /transcript\.srt/ });
    expect(srtButton.textContent).toContain(formatBytes(srt?.bytes.length ?? 0));
    expect(screen.getByTestId('download-zip').textContent).toBe(`Download .zip (${bundle.files.length} files)`);
    expect(screen.getByTestId('file-content').textContent).toBe(fileText(bundle.files.find((f) => f.path === 'context.md') as typeof srt & {}));
    await userEvent.click(srtButton);
    await waitFor(() => expect(screen.getByTestId('file-content').textContent).toBe(fileText(srt as typeof srt & {})));
    expect(srtButton.getAttribute('aria-current')).toBe('true');
  });
});
