// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiPlayground } from '../src/components/api/ApiPlayground.tsx';
import type { Health } from '../src/lib/api.ts';
import { ApiStatusProvider } from '../src/lib/api-status.tsx';
import { EXAMPLES } from '../src/lib/examples.ts';
import { BASE, recorded, replay } from './helpers.ts';

const realFetch = globalThis.fetch;
const MISSING = 'https://www.youtube.com/watch?v=xxxxxxxxxxx';

function renderPage(endpoint?: string, video?: string) {
  const health = recorded('health.json').body as Health;
  return render(
    createElement(
      ApiStatusProvider,
      { initial: { status: 'online', base: BASE, health } },
      createElement(ApiPlayground, { initial: { endpoint, video } }),
    ),
  );
}

beforeEach(() => {
  globalThis.fetch = replay('openapi.json', 'health.json', 'context-not-found.json');
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe('API page', () => {
  it('starts on the context route with the first recommended video', () => {
    renderPage();
    expect(screen.getByTestId('api-endpoint-title').textContent).toBe('Full video context');
    expect((screen.getByTestId('api-video') as HTMLInputElement).value).toBe(EXAMPLES[0]?.url);
    expect(screen.getByTestId('api-request-url').textContent).toBe(
      `GET ${BASE}/context?url=${encodeURIComponent(EXAMPLES[0]?.url ?? '')}`,
    );
  });

  it('rebuilds every request when another recommended video is picked', async () => {
    renderPage('research');
    const second = EXAMPLES[1];
    if (!second) throw new Error('needs two examples');
    await userEvent.click(screen.getByRole('button', { name: second.label }));
    const body = screen.getByLabelText(/^Body/) as HTMLTextAreaElement;
    expect(JSON.parse(body.value)).toMatchObject({ urls: [second.url], query: second.topic });
  });

  it('sends a request and shows the real answer', async () => {
    renderPage('health');
    await userEvent.click(screen.getByTestId('api-send'));
    const res = await screen.findByTestId('api-response');
    expect(res.getAttribute('data-status')).toBe('200');
    expect(screen.getByTestId('api-response-body').textContent).toContain('"name": "vid2context"');
  });

  it('shows the error code and hint of a failed call', async () => {
    renderPage('context', MISSING);
    await userEvent.click(screen.getByTestId('api-send'));
    const res = await screen.findByTestId('api-response');
    expect(res.getAttribute('data-status')).toBe('404');
    expect(within(res).getByText('not-found')).toBeTruthy();
  });

  it('lists routes from the server OpenAPI document', async () => {
    renderPage();
    const list = screen.getByTestId('api-endpoint-list');
    await waitFor(() => expect(within(list).getByRole('region', { name: 'Other' })).toBeTruthy());
  });

  it('keeps Send disabled until required fields are filled', () => {
    renderPage('collections-get');
    expect((screen.getByTestId('api-send') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Fill in id to send.')).toBeTruthy();
  });
});
