// @vitest-environment jsdom
/**
 * A failed run shows ways to still get the result, best first, with the error
 * folded into "Technical details". The blocked error is the one a cloud
 * server got from YouTube (packages/server/test/recovery.test.ts produces the
 * same body from recorded YouTube responses).
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Vid2ContextError } from '@vid2context/core';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearDownloadStatusCache } from '../src/components/download/use-download-status.ts';
import { KeyForm, RecoveryPanel, RetryAction } from '../src/components/recovery/RecoveryPanel.tsx';
import type { Health } from '../src/lib/api.ts';
import { type ApiState, ApiStatusProvider } from '../src/lib/api-status.tsx';
import { fromApiBody } from '../src/lib/errors.ts';
import { acceptedKeyNames, isRemoteApi, webRecoveries, webRecoveryContext } from '../src/lib/recovery.ts';
import type { RunParams } from '../src/lib/route.ts';
import { BASE, recorded, replay } from './helpers.ts';

const URL = 'https://www.youtube.com/watch?v=Il2bjGSXvSw';
const MESSAGE =
  'YouTube player Il2bjGSXvSw: every client failed (android: LOGIN_REQUIRED: Sign in to confirm you’re not a bot; ios: LOGIN_REQUIRED: Sign in to confirm you’re not a bot)';
const blocked = () =>
  fromApiBody(
    {
      error: { code: 'blocked', message: MESSAGE, hint: 'YouTube is refusing requests from this IP address.' },
      attempts: [
        { id: 'youtube', stage: 'resolve', outcome: 'ok', detail: 'youtube:Il2bjGSXvSw' },
        { id: 'youtube', stage: 'metadata', outcome: 'error', reason: 'blocked', detail: MESSAGE },
      ],
    },
    503,
  );

const health = recorded('health.json').body as Health;
/** The recorded health plus the requestKeys field current servers add (asserted in packages/server/test/recovery.test.ts). */
const onlineWithKeys: ApiState = {
  status: 'online',
  base: BASE,
  health: { ...health, requestKeys: { accepted: true, names: ['GROQ_API_KEY', 'SUPADATA_API_KEY'] } },
};
const params: RunParams = { url: URL, mode: 'auto', lang: '', comments: false, timestamps: false };
const wrap = (node: ReactNode, initial: ApiState = onlineWithKeys) =>
  createElement(ApiStatusProvider, { initial } as { initial: ApiState; children: ReactNode }, node);

beforeEach(clearDownloadStatusCache);
afterEach(cleanup);

describe('RecoveryPanel', () => {
  it('turns a YouTube block into ranked ways forward, download first, with the error folded away', async () => {
    const retries: unknown[] = [];
    render(
      wrap(
        createElement(RecoveryPanel, {
          params,
          error: blocked(),
          onRetry: (keys) => retries.push(keys),
          onImported: () => undefined,
          call: { fetch: replay('downloads-status.json') },
        }),
      ),
    );
    expect(screen.getByRole('heading', { name: "Let's get this another way" })).toBeTruthy();
    expect(screen.getByTestId('recovery-reason').textContent).toContain('YouTube is refusing requests from this server');
    // The server offers downloads (recorded status): the import panel ranks first and lists what it covers.
    await waitFor(() => expect(screen.getByTestId('recovery-download-media')).toBeTruthy());
    const steps = within(screen.getByRole('list', { name: 'Ways to get the result' }))
      .getAllByRole('listitem')
      .filter((li) => li.dataset.testid?.startsWith('recovery-'));
    expect(steps.map((li) => li.dataset.testid)).toEqual(['recovery-download-media', 'recovery-add-key', 'recovery-retry']);
    const first = steps[0] as HTMLElement;
    expect(first.textContent).toContain('Download the audio and transcribe it');
    expect(first.textContent).toContain('Paste or upload the transcript');
    expect(within(first).getByTestId('import-panel')).toBeTruthy();
    // No red alert up front; the message is in the closed details.
    expect(screen.queryByRole('alert')).toBeNull();
    const details = screen.getByTestId('recovery-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByTestId('error-message').textContent).toBe(MESSAGE);
    expect(details.textContent).toContain('What was tried (2)');
  });

  it('offers only the keys the server accepts, and sends an entered key with the retry even without storage', async () => {
    const retries: (Record<string, string> | undefined)[] = [];
    render(
      wrap(
        createElement(RecoveryPanel, {
          params,
          error: blocked(),
          onRetry: (keys) => retries.push(keys),
          onImported: () => undefined,
          call: { fetch: replay('downloads-status.json') },
        }),
      ),
    );
    const form = await screen.findByTestId('recovery-key-form');
    expect(within(form).getByLabelText(/Supadata/)).toBeTruthy();
    expect(
      within(form)
        .getByRole('link', { name: /Get a key \(100 transcripts a month\)/ })
        .getAttribute('href'),
    ).toBe('https://supadata.ai');
    const submit = within(form).getByTestId('recovery-key-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await userEvent.type(within(form).getByLabelText(/Supadata/), ' sd_live_key ');
    await userEvent.click(submit);
    // jsdom has no IndexedDB, like a private window: the key still goes with this one retry.
    await waitFor(() => expect(retries).toEqual([{ SUPADATA_API_KEY: 'sd_live_key' }]));
  });

  it('keeps the key in the browser and does not retry when sending is turned off', async () => {
    const saved: unknown[] = [];
    const recovery = webRecoveries(blocked(), webRecoveryContext(onlineWithKeys, URL, { downloads: false })).find(
      (r) => r.action === 'add-key',
    );
    if (!recovery) throw new Error('expected an add-key recovery');
    render(createElement(KeyForm, { recovery, onSaved: (k) => saved.push(k) }));
    await userEvent.type(screen.getByLabelText(/Supadata/), 'sd_key');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Save in this browser' }));
    expect((await screen.findByTestId('recovery-key-note')).textContent).toContain('cannot store keys');
    expect(saved).toEqual([]);
  });

  it('switches a captions-only run to transcription instead of stopping', async () => {
    const err = new Vid2ContextError('no-transcript', 'Could not get a transcript for youtube:Il2bjGSXvSw (mode: captions).');
    render(
      wrap(
        createElement(RecoveryPanel, {
          params: { ...params, mode: 'captions' },
          error: err,
          onRetry: () => undefined,
          onImported: () => undefined,
          call: { fetch: replay('downloads-status.json') },
        }),
      ),
    );
    expect(await screen.findByTestId('recovery-switch-mode-button')).toBeTruthy();
  });
});

describe('RetryAction', () => {
  it('counts down and retries once by itself, and can be stopped', async () => {
    let n = 0;
    render(createElement(RetryAction, { retryAfterSec: 1, onRetry: () => n++ }));
    expect(screen.getByRole('status').textContent).toContain('Trying again by itself in 1 s');
    await waitFor(() => expect(n).toBe(1), { timeout: 2500 });

    cleanup();
    let m = 0;
    render(createElement(RetryAction, { retryAfterSec: 1, onRetry: () => m++ }));
    await userEvent.click(screen.getByRole('button', { name: "Don't" }));
    await new Promise((r) => setTimeout(r, 1300));
    expect(m).toBe(0);
  });
});

describe('recovery helpers', () => {
  it('reads accepted key names from health and tells a remote API from a local one', () => {
    expect(acceptedKeyNames(onlineWithKeys)).toEqual(['GROQ_API_KEY', 'SUPADATA_API_KEY']);
    expect(acceptedKeyNames({ status: 'online', base: BASE, health })).toEqual([]);
    expect(isRemoteApi(BASE)).toBe(false);
    expect(isRemoteApi('/api/v1', 'https://vid2context.com/app/')).toBe(true);
  });
});
