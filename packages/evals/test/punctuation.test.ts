import { cleanTranscript } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { punctuationF1, punctuationTokens } from '../src/metrics/punctuation.ts';
import { textOf } from '../src/refs.ts';
import { fixtureRef, zooAutoPlain, zooAutoPunct, zooCreator } from './helpers.ts';

describe('punctuation and capitalization F1 against creator captions', () => {
  const creator = textOf(zooCreator());

  it('labels real caption tokens', () => {
    const t = punctuationTokens('All right, so here we are, in front of the elephants');
    expect(t[0]).toEqual({ key: 'all', mark: '', upper: true });
    expect(t[1]).toEqual({ key: 'right', mark: ',', upper: false });
    expect(punctuationTokens('really...').at(-1)?.mark).toBe('.');
    expect(punctuationTokens('[Music]')).toEqual([]);
  });

  it('is perfect for the creator text against itself', () => {
    const s = punctuationF1(creator, creator);
    expect(s.punctuation.f1).toBe(1);
    expect(s.capitalization.fn).toBe(0);
  });

  it('gives unpunctuated auto-captions zero punctuation recall', () => {
    const s = punctuationF1(creator, textOf(zooAutoPlain()));
    expect(s.matched).toBeGreaterThan(25);
    expect(s.punctuation.tp).toBe(0);
    expect(s.punctuation.recall).toBe(0);
    expect(s.punctuation.fn).toBeGreaterThan(0);
  });

  it('scores punctuated auto-captions between the two', () => {
    const s = punctuationF1(creator, textOf(zooAutoPunct()));
    expect(s.punctuation.fp + s.punctuation.tp).toBeGreaterThan(0);
    expect(s.capitalization.fp).toBeGreaterThan(0);
    expect(s.punctuation.f1).toBeLessThan(1);
  });

  it('measures what core cleanup adds to raw auto-captions', async () => {
    const auto = fixtureRef('youtube-9Pd5fi1DCb8.auto-captions.en.json');
    const raw = punctuationF1(creator, textOf(auto.segments));
    const cleaned = await cleanTranscript({
      ref: { input: auto.url ?? '', platform: 'youtube', kind: 'video', id: auto.videoId, nativeId: '9Pd5fi1DCb8' },
      language: auto.language,
      origin: auto.origin,
      producer: auto.producer,
      segments: auto.segments,
      createdAt: `${auto.recordedAt}T00:00:00.000Z`,
    });
    const after = punctuationF1(creator, textOf(cleaned.transcript.segments));
    expect(after.matched).toBeGreaterThan(0);
    expect(after.punctuation.tp + after.punctuation.fp).toBeGreaterThanOrEqual(raw.punctuation.tp + raw.punctuation.fp);
  });
});
