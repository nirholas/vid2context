import { describe, expect, it } from 'vitest';
import { downloadLimitsText } from '../src/lib/format.ts';

describe('downloadLimitsText', () => {
  it('leaves out limits of 0, which mean none (a local server)', () => {
    expect(downloadLimitsText({ maxBytes: 0, maxDurationSec: 0, ttlMin: 60 })).toBe(
      'Videos of any length and size; the file stays on the server for 60 min.',
    );
  });

  it('names both limits on a public server', () => {
    expect(downloadLimitsText({ maxBytes: 1024 * 1024 * 1024, maxDurationSec: 7200, ttlMin: 30 })).toBe(
      'Videos up to 2:00:00 long and up to 1.00 GB; the file stays on the server for 30 min.',
    );
  });

  it('names only the limit that is set', () => {
    expect(downloadLimitsText({ maxBytes: 0, maxDurationSec: 600, ttlMin: 0 })).toBe('Videos up to 10:00 long.');
  });
});
