// @vitest-environment jsdom
import { FORMAT_FILE_NAMES, formatters } from '@vid2context/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ResultView } from '../src/components/results/ResultView.tsx';
import { fileText, resultBundle, viewFiles } from '../src/lib/bundle.ts';
import { formatBytes } from '../src/lib/format.ts';
import { sharedContext } from './helpers.ts';

afterEach(cleanup);

const createdAt = new Date('2026-11-14T16:00:00.000Z');

function expectedName(id: string): string {
  const f = formatters[id];
  return FORMAT_FILE_NAMES[id] ?? `${id}.${f?.extension}`;
}

describe('the file list', () => {
  it('has one file per formatter in the core formatters map, context.md first', async () => {
    const files = viewFiles(await resultBundle([sharedContext('youtube-jNQXAC9IVRw')], { createdAt }));
    const paths = files.map((f) => f.path);
    for (const id of Object.keys(formatters)) expect(paths).toContain(expectedName(id));
    expect(paths[0]).toBe('context.md');
    expect(paths).toContain('metadata.json');
    expect(paths.slice(-2)).toEqual(['README.md', 'manifest.json']);
  });

  it('adds chapters.md only for videos with chapters, and comments.md only with comments', async () => {
    const zoo = viewFiles(await resultBundle([sharedContext('youtube-jNQXAC9IVRw')], { createdAt })).map((f) => f.path);
    const gwagon = viewFiles(await resultBundle([sharedContext('youtube-cCPsdFdlshc')], { createdAt })).map((f) => f.path);
    expect(zoo).toContain('chapters.md');
    expect(gwagon).not.toContain('chapters.md');
    expect(zoo).not.toContain('comments.md');
  });

  it('writes transcript.txt with [m:ss] lines when asked, and keeps manifest.json in step', async () => {
    const context = sharedContext('youtube-jNQXAC9IVRw');
    const plain = await resultBundle([context], { createdAt });
    const stamped = await resultBundle([context], { createdAt, timestamps: true });
    const txt = (b: typeof plain) => fileText(b.files.find((f) => f.path === 'transcript.txt') as (typeof plain.files)[number]);
    expect(txt(plain)).not.toMatch(/^\[0:00\]/);
    expect(txt(stamped).split('\n')[0]).toMatch(/^\[0:00\] /);
    const entry = stamped.manifest.files.find((f) => f.path === 'transcript.txt');
    const bytes = stamped.files.find((f) => f.path === 'transcript.txt')?.bytes as Uint8Array;
    expect(entry?.bytes).toBe(bytes.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    expect(entry?.sha256).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''));
    const manifestFile = JSON.parse(fileText(stamped.files.find((f) => f.path === 'manifest.json') as (typeof plain.files)[number]));
    expect(manifestFile.files.find((f: { path: string }) => f.path === 'transcript.txt').sha256).toBe(entry?.sha256);
    const zip = new Uint8Array(await new Response(stamped.zip()).arrayBuffer());
    expect(String.fromCharCode(zip[0] as number, zip[1] as number)).toBe('PK');
  });

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
