// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { agentPrompt } from '@vid2context/core';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FileViewer } from '../src/components/results/FileViewer.tsx';
import { CopyButton } from '../src/components/ui.tsx';
import { fileText, resultBundle, viewFiles } from '../src/lib/bundle.ts';
import { toBlob } from '../src/lib/download.ts';
import { sharedContext } from './helpers.ts';

afterEach(cleanup);

async function file(path: string) {
  const files = viewFiles(
    await resultBundle([sharedContext('youtube-cCPsdFdlshc')], { createdAt: new Date('2026-11-14T16:00:00Z') }),
  );
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path}`);
  return f;
}

describe('FileViewer', () => {
  it('shows the file in a labeled, keyboard-scrollable monospace region', async () => {
    const f = await file('transcript.vtt');
    render(createElement(FileViewer, { file: f }));
    const region = screen.getByRole('region', { name: 'Contents of transcript.vtt' });
    expect(region.getAttribute('tabindex')).toBe('0');
    const pre = screen.getByTestId('file-content');
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent?.startsWith('WEBVTT')).toBe(true);
    expect(pre.textContent).toBe(fileText(f));
  });

  it('copies the whole file', async () => {
    const user = userEvent.setup();
    const f = await file('transcript.srt');
    render(createElement(FileViewer, { file: f }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(fileText(f));
    expect(screen.getAllByText('Copied transcript.srt').length).toBeGreaterThan(0);
  });

  it('downloads the exact bytes with the formatter mime type', async () => {
    const f = await file('context.json');
    render(createElement(FileViewer, { file: f }));
    expect(screen.getByRole('button', { name: 'Download context.json' })).toBeTruthy();
    const blob = toBlob(f.bytes, f.mimeType);
    expect(blob.type).toBe('application/json');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(f.bytes));
    expect(JSON.parse(await blob.text()).metadata.ref.id).toBe('youtube:cCPsdFdlshc');
  });
});

describe('Copy for agents', () => {
  it('copies the agent prompt from core with citation instructions', async () => {
    const user = userEvent.setup();
    const context = sharedContext('youtube-jNQXAC9IVRw');
    const text = agentPrompt([context]);
    render(createElement(CopyButton, { getText: () => text, label: 'Copy for agents', copiedLabel: 'Copied for agents' }));
    await user.click(screen.getByRole('button', { name: 'Copy for agents' }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toBe(text);
    expect(copied).toContain('Me at the zoo');
    expect(copied).toContain('Cite with timestamp links');
  });
});
