/**
 * renderError: aborted and timed-out signals are not server faults. A client
 * that hangs up (a canceled fetch, a closed tab) used to log "unhandled error
 * Aborted" and answer 500; an expired per-request deadline answered 500 too.
 */
import { Vid2ContextError } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { renderError } from '../src/errors.ts';

describe('renderError', () => {
  it('answers 499 and does not log when the client canceled the request', () => {
    const controller = new AbortController();
    controller.abort();
    const r = renderError(controller.signal.reason);
    expect(r.status).toBe(499);
    expect(r.unexpected).toBe(false);
    expect(r.body.error.code).toBe('aborted');
  });

  it('answers 504 timeout when the per-request deadline signal expired', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    const r = renderError(signal.reason);
    expect(r.status).toBe(504);
    expect(r.unexpected).toBe(false);
    expect(r.body.error.code).toBe('timeout');
    expect(r.body.error.hint).toBeTruthy();
  });

  it('keeps a Vid2ContextError as raised, whatever its name', () => {
    const r = renderError(new Vid2ContextError('rate-limited', 'Slow down.', { retryAfterSec: 3 }));
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('3');
  });

  it('still answers 500 internal for anything else', () => {
    const r = renderError(new Error('boom'));
    expect(r.status).toBe(500);
    expect(r.unexpected).toBe(true);
    expect(r.body.error.message).toBe('Internal error');
  });
});
