import { describe, expect, it } from 'vitest';
import { normalizeWords, numberWordsToDigits } from '../src/normalize.ts';
import { loadFixture } from './helpers.ts';

describe('normalizeWords', () => {
  it('drops annotations, fillers and punctuation from real auto-captions', () => {
    // Segments 4 to 6 of the 2021 reupload 9Pd5fi1DCb8 ("Me at the zoo").
    const c = loadFixture('youtube-9Pd5fi1DCb8.json');
    const text = c.transcript.segments
      .slice(3, 6)
      .map((s) => s.text)
      .join(' ');
    expect(text).toBe("really really long um fronts and that's that's cool [Music]");
    expect(normalizeWords(text)).toEqual(['really', 'really', 'long', 'fronts', 'and', 'thats', 'thats', 'cool']);
  });

  it('gives creator captions and auto-captions of the same words the same form', () => {
    const creator = loadFixture('youtube-jNQXAC9IVRw.json', 'shared').transcript.segments[0]?.text ?? '';
    const auto = loadFixture('youtube-g5RBHWskGtc.json').transcript.segments[0]?.text ?? '';
    expect(creator).toBe('All right, so here we are, in front of the elephants');
    expect(normalizeWords(creator).slice(0, 5)).toEqual(['all', 'right', 'so', 'here', 'we']);
    expect(normalizeWords(auto).slice(0, 5)).toEqual(['all', 'right', 'so', 'here', 'we']);
  });

  it('maps spoken numbers to digits and leaves separate numbers separate', () => {
    expect(numberWordsToDigits(['twenty', 'five', 'years'])).toEqual(['25', 'years']);
    expect(numberWordsToDigits(['one', 'hundred', 'and', 'five'])).toEqual(['105']);
    expect(numberWordsToDigits(['two', 'thousand', 'twelve'])).toEqual(['2012']);
    expect(numberWordsToDigits(['one', 'two', 'three'])).toEqual(['1', '2', '3']);
    expect(numberWordsToDigits(['rock', 'and', 'roll'])).toEqual(['rock', 'and', 'roll']);
    expect(normalizeWords('$5, 1,000 people and 10% of them')).toEqual(['5', 'dollars', '1000', 'people', 'and', '10', 'percent', 'of', 'them']);
  });
});
