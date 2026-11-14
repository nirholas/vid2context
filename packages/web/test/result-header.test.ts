// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ResultHeader } from '../src/components/results/ResultHeader.tsx';
import { recorded, sharedContext } from './helpers.ts';
import type { VideoContext } from '@vid2context/core';

afterEach(cleanup);

describe('ResultHeader', () => {
  it('shows title, channel, duration, thumbnail and creator captions for "Me at the zoo"', () => {
    const context = sharedContext('youtube-jNQXAC9IVRw');
    const { container } = render(createElement(ResultHeader, { context }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Me at the zoo');
    const channel = screen.getByRole('link', { name: 'jawed' });
    expect(channel.getAttribute('href')).toBe('https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A');
    expect(container.textContent).toContain('0:19');
    expect(screen.getByText('Duration 19 seconds')).toBeTruthy();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(context.metadata.thumbnailUrl);
    const badges = within(screen.getByRole('list', { name: 'How the transcript was made' })).getAllByTestId('origin-badge');
    expect(badges.map((b) => b.firstChild?.textContent)).toEqual(['Creator captions']);
  });

  it('labels auto-captions in plain words', () => {
    render(createElement(ResultHeader, { context: sharedContext('youtube-cCPsdFdlshc') }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(sharedContext('youtube-cCPsdFdlshc').metadata.title);
    expect(screen.getAllByTestId('origin-badge')[0]?.firstChild?.textContent).toBe('Auto-captions');
  });

  it('names the speech-to-text rung when the audio was transcribed', () => {
    const context = recorded('context-jNQXAC9IVRw.json').body as VideoContext;
    render(createElement(ResultHeader, { context }));
    expect(screen.getAllByTestId('origin-badge')[0]?.firstChild?.textContent).toBe(
      'Transcribed by stt/cloudflare/@cf/openai/whisper-large-v3-turbo',
    );
  });

  it('adds a machine-translated badge when the transcript was translated', () => {
    const base = sharedContext('youtube-jNQXAC9IVRw');
    const context = { ...base, transcript: { ...base.transcript, translated: true } };
    render(createElement(ResultHeader, { context }));
    expect(screen.getAllByTestId('origin-badge').map((b) => b.firstChild?.textContent)).toEqual(['Creator captions', 'Machine-translated']);
  });
});
