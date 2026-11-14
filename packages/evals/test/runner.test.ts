import { describe, expect, it } from 'vitest';
import { parseArgs, SUITES } from '../src/args.ts';
import { checkThresholds, loadThresholds } from '../src/check.ts';
import { costOf, priceKey } from '../src/metrics/cost.ts';
import { liveAllowed, main } from '../src/run.ts';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
}

describe('the live gate', () => {
  it('refuses to start without LIVE=1 or --live, says why, and never sets up the registry', async () => {
    const o = io();
    let setupCalled = false;
    const code = await main(['--suite', 'stt'], {
      env: {},
      setup: async () => {
        setupCalled = true;
        throw new Error('must not be called');
      },
      stdout: o.stdout,
      stderr: o.stderr,
    });
    expect(code).toBe(2);
    expect(setupCalled).toBe(false);
    expect(o.out).toEqual([]);
    expect(o.err.join('')).toMatch(/LIVE=1/);
    expect(o.err.join('')).toMatch(/Nothing was evaluated/);
  });

  it('accepts LIVE=1, LIVE=true or --live', () => {
    expect(liveAllowed({ LIVE: '1' }, { live: false })).toBe(true);
    expect(liveAllowed({ LIVE: 'true' }, { live: false })).toBe(true);
    expect(liveAllowed({}, { live: true })).toBe(true);
    expect(liveAllowed({ LIVE: '0' }, { live: false })).toBe(false);
  });

  it('prints help without the gate', async () => {
    const o = io();
    expect(await main(['--help'], { env: {}, setup: async () => Promise.reject(new Error('no')), ...o })).toBe(0);
    expect(o.out.join('')).toMatch(/--suite/);
  });

  it('refuses a suite whose package has not landed, before any network setup', async () => {
    const o = io();
    const code = await main(['--suite', 'search', '--live'], {
      env: {},
      setup: async () => Promise.reject(new Error('no')),
      ...o,
    });
    expect(code).toBe(2);
    expect(o.err.join('')).toMatch(/search suite/);
  });
});

describe('parseArgs', () => {
  it('parses every flag', () => {
    const a = parseArgs([
      '--suite',
      'all',
      '--rungs',
      'stt/ovh/whisper-large-v3-turbo, groq',
      '--limit=3',
      '--out',
      'x',
      '--json',
      '--check',
    ]);
    expect(a.suites).toEqual(SUITES);
    expect(a.rungs).toEqual(['stt/ovh/whisper-large-v3-turbo', 'groq']);
    expect(a.limit).toBe(3);
    expect(a).toMatchObject({ out: 'x', json: true, check: true, live: false });
  });

  it('rejects unknown suites, flags and bad limits with a hint', () => {
    expect(() => parseArgs(['--suite', 'nope'])).toThrow(/Unknown suite/);
    expect(() => parseArgs(['--fast'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--rungs'])).toThrow(/needs a value/);
  });
});

describe('cost', () => {
  it('is zero for free, keyless and local rungs', () => {
    expect(costOf('stt/ovh/whisper-large-v3-turbo', 'keyless', { audioSec: 600 })).toBe(0);
    expect(costOf('stt/groq/whisper-large-v3-turbo', 'free', { audioSec: 600 })).toBe(0);
  });

  it('prices listed paid rungs per audio minute, pooled keys included, and refuses to guess the rest', () => {
    expect(priceKey('stt/openai#2/whisper-1')).toBe('stt/openai/whisper-1');
    expect(costOf('stt/openai#2/whisper-1', 'paid', { audioSec: 120 })).toBeCloseTo(0.012, 10);
    expect(costOf('stt/someone/model-x', 'paid', { audioSec: 120 })).toBeNull();
  });
});

describe('thresholds', () => {
  it('loads the committed thresholds file', () => {
    expect(loadThresholds().stt).toBeDefined();
  });

  it('flags a rung over its limit and ignores rungs with no successful items', () => {
    const t = { stt: { a: { maxWer: 0.2, maxP90LatencyMs: 1000 }, b: { maxWer: 0.2 } } };
    const v = checkThresholds(
      'stt',
      [
        { rung: 'a', items: 2, ok: 2, wer: 0.25, p90LatencyMs: 500 },
        { rung: 'b', items: 2, ok: 0 },
        { rung: 'c', items: 1, ok: 1, wer: 0.9 },
      ],
      t,
    );
    expect(v).toEqual([{ suite: 'stt', rung: 'a', metric: 'maxWer', limit: 0.2, actual: 0.25 }]);
  });
});
