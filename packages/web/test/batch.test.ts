/**
 * The batch view's bookkeeping: repeated entries, the progress line (a failure
 * is finished but never "done") and retry wait text.
 */
import type { VideoRef } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { batchCounts, type ItemState, progressText, uniqueRefs, waitText } from '../src/components/batch/BatchView.tsx';
import { toAppError } from '../src/lib/errors.ts';
import { sharedContext } from './helpers.ts';

const ref = (id: string): VideoRef => ({
  input: `https://www.youtube.com/watch?v=${id}`,
  platform: 'youtube',
  kind: 'video',
  id: `youtube:${id}`,
  nativeId: id,
  url: `https://www.youtube.com/watch?v=${id}`,
});

describe('batch view bookkeeping', () => {
  it('drops repeated videos, keeping the first', () => {
    const { items, repeats } = uniqueRefs([ref('MxMrnsxX9ZA'), ref('jNQXAC9IVRw'), ref('MxMrnsxX9ZA')]);
    expect(items.map((r) => r.nativeId)).toEqual(['MxMrnsxX9ZA', 'jNQXAC9IVRw']);
    expect(repeats).toBe(1);
  });

  it('counts a failure as finished but not done', () => {
    const states: Record<string, ItemState> = {
      a: { status: 'done', context: sharedContext('youtube-jNQXAC9IVRw') },
      b: { status: 'error', error: toAppError(new Error('blocked')) },
      c: { status: 'running' },
      d: { status: 'idle' },
    };
    const counts = batchCounts(states);
    expect(counts).toEqual({ total: 3, done: 1, failed: 1 });
    expect(progressText(counts, true)).toBe('1 of 3 done, 1 failed, up to 3 at a time');
    expect(progressText({ total: 3, done: 0, failed: 1 }, false)).toBe('0 of 3 done, 1 failed');
  });

  it('says how long a retry wait is in words a person reads', () => {
    expect(waitText(45_000)).toBe('45 s');
    expect(waitText(545_000)).toBe('9 min 5 s');
    expect(waitText(600_000)).toBe('10 min');
    expect(waitText(3_720_000)).toBe('1 h 2 min');
    expect(waitText(-5)).toBe('0 s');
  });
});
