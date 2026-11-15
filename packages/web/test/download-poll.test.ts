// @vitest-environment jsdom
/**
 * The download job view must not stall: a failed poll (a 429 from the
 * server's per-IP rate limit, shared by every tab) is retried with backoff
 * that honours Retry-After, and only a job the server no longer has ends the
 * view. Responses are real recordings (see test/fixtures/README.md).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { replayFetch } from '@vid2context/core/testing';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadJobView } from '../src/components/download/DownloadJobView.tsx';
import { type DownloadJob, isFatalPollError, nextPollDelay, POLL_HIDDEN_MS, POLL_MAX_MS } from '../src/lib/downloads.ts';
import { fromApiBody, parseRetryAfter } from '../src/lib/errors.ts';
import { BASE, recorded } from './helpers.ts';

type WithHeaders = ReturnType<typeof recorded> & { headers?: Record<string, string> };

/** Serve the recordings of one path in order (the last repeats), with any headers they kept. */
function serveInOrder(...names: string[]) {
  const list = names.map((n) => recorded(n) as WithHeaders);
  const pathname = new URL(`${BASE}${list[0]?.request.path}`).pathname;
  let i = 0;
  return replayFetch([
    {
      method: 'GET',
      url: (u: URL) => u.pathname === pathname,
      response: () => {
        const r = list[Math.min(i++, list.length - 1)] as WithHeaders;
        return {
          status: r.status,
          headers: { 'content-type': r.contentType, ...(r.headers ?? {}) },
          body: JSON.stringify(r.body),
        };
      },
    },
  ]);
}

const started = recorded('downloads-start.json').body as DownloadJob;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('poll backoff', () => {
  it('polls at the normal rate while healthy, and slower in a hidden tab', () => {
    expect(nextPollDelay({ pollMs: 700, failures: 0 })).toBe(700);
    expect(nextPollDelay({ pollMs: 700, failures: 0, hidden: true })).toBe(POLL_HIDDEN_MS);
  });

  it('doubles after each failure up to the cap', () => {
    expect(nextPollDelay({ pollMs: 700, failures: 1 })).toBe(1400);
    expect(nextPollDelay({ pollMs: 700, failures: 2 })).toBe(2800);
    expect(nextPollDelay({ pollMs: 700, failures: 9 })).toBe(POLL_MAX_MS);
  });

  it('never polls sooner than Retry-After says', () => {
    expect(nextPollDelay({ pollMs: 700, failures: 1, retryAfterSec: 60 })).toBe(60_000);
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('60')).toBe(60);
    expect(parseRetryAfter('Sun, 15 Nov 2026 15:09:00 GMT', Date.parse('Sun, 15 Nov 2026 15:08:00 GMT'))).toBe(60);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('retries rate limits but not a job that is gone', () => {
    const limited = recorded('downloads-job-rate-limited.json') as WithHeaders;
    const gone = recorded('downloads-job-gone.json');
    const limitedErr = fromApiBody(limited.body as never, limited.status, parseRetryAfter(limited.headers?.['retry-after']));
    expect(limitedErr.code).toBe('rate-limited');
    expect(limitedErr.retryAfterSec).toBe(60);
    expect(isFatalPollError(limitedErr)).toBe(false);
    expect(isFatalPollError(fromApiBody(gone.body as never, gone.status))).toBe(true);
  });
});

describe('DownloadJobView polling', () => {
  it('keeps polling through a 429, waits out Retry-After, and finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = serveInOrder(
      'downloads-job-running.json',
      'downloads-job-rate-limited.json',
      'downloads-job-running.json',
      'downloads-job-done.json',
    );
    render(createElement(DownloadJobView, { job: started, call: { base: BASE, fetch }, pollMs: 10 }));

    const note = await screen.findByTestId('download-reconnecting');
    expect(note.textContent).toContain('retry in 60 s');
    expect(note.textContent).toContain('Too many requests');
    const callsAtLimit = fetch.calls.length;

    // Nothing is sent before Retry-After runs out.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetch.calls.length).toBe(callsAtLimit);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await screen.findByTestId('download-done')).toBeTruthy();
    expect(screen.queryByTestId('download-reconnecting')).toBeNull();
  });

  it('shows the error at once when the server no longer has the job', async () => {
    const fetch = serveInOrder('downloads-job-gone.json');
    render(createElement(DownloadJobView, { job: started, call: { base: BASE, fetch }, pollMs: 10 }));
    expect((await screen.findByTestId('error-message')).textContent).toContain('No download with id');
    expect(fetch.calls).toHaveLength(1);
  });
});
