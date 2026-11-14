import { describe, expect, it } from 'vitest';
import { isEnglish, normalizeText, normalizeWords, spellNumber } from '../src/metrics/normalize.ts';
import { fixtureRef, sharedContext } from './helpers.ts';

describe('normalizeText on real caption lines', () => {
  it('drops bracketed tags, parenthesized sounds and trailing ellipses (Me at the zoo creator captions)', () => {
    const segs = sharedContext('youtube-jNQXAC9IVRw.json').transcript.segments;
    expect(segs[4]?.text).toBe('(baaaaaaaaaaahhh!!)');
    expect(normalizeText(segs[4]?.text ?? '')).toBe('');
    expect(normalizeText(segs[1]?.text ?? '')).toBe('the cool thing about these guys is that they have really');
    expect(normalizeText(segs[0]?.text ?? '')).toBe('all right so here we are in front of the elephants');
  });

  it('removes [Music] and the filler "um" from auto-captions', () => {
    const segs = fixtureRef('youtube-9Pd5fi1DCb8.auto-captions.en.json').segments;
    expect(segs[5]?.text).toBe('[Music]');
    expect(normalizeText(segs[5]?.text ?? '')).toBe('');
    expect(normalizeText(segs[3]?.text ?? '')).toBe('really really long');
    expect(normalizeText(segs[3]?.text ?? '', { fillers: true })).toBe('really really long um');
  });

  it('joins apostrophes so "that\'s" is one word in both tracks', () => {
    expect(normalizeText("and that's cool")).toBe('and thats cool');
    expect(normalizeText("trunks. And that's that's cool.")).toBe('trunks and thats thats cool');
  });

  it('spells numbers and strips thousands separators (G-Wagon auto-captions)', () => {
    const segs = sharedContext('youtube-cCPsdFdlshc.json').transcript.segments;
    const line = segs.find((s) => s.text.includes('171,000'))?.text ?? '';
    expect(line).toBe('this one again 171,000 171,000 Mi on a');
    expect(normalizeText(line)).toBe('this one again 171000 171000 mi on a');
    const power = segs.find((s) => s.text.startsWith('300 horsepower'))?.text ?? '';
    expect(normalizeText(power)).toBe('three hundred horsepower and three hundred ftlb of torque');
    const year = segs.find((s) => s.text.startsWith('G500 the second one'))?.text ?? '';
    expect(normalizeText(year)).toBe('g five hundred the second one is a to two thousand twelve g fifty five');
  });

  it('expands contractions so "don\'t" and "do not" agree', () => {
    const segs = sharedContext('youtube-cCPsdFdlshc.json').transcript.segments;
    const line = segs.find((s) => s.text.includes("I don't want"))?.text ?? '';
    expect(line).toBe("wrong one I don't want you getting");
    expect(normalizeText(line)).toBe('wrong one i do not want you getting');
    expect(normalizeText("we're going to do a year-by-year")).toBe('we are going to do a year by year');
  });

  it('leaves digits and contractions alone outside English', () => {
    expect(normalizeText('Im Jahr 2026 waren es 1.000 Leute', { language: 'de' })).toBe('im jahr 2026 waren es 1000 leute');
    expect(normalizeWords('隠れた世界 - 限定版カレンダー！', { language: 'ja' })).toEqual(['隠れた世界', '限定版カレンダー']);
  });
});

describe('spellNumber and isEnglish', () => {
  it('spells 0 to 9999 and passes larger numbers through', () => {
    expect(spellNumber(0)).toBe('zero');
    expect(spellNumber(21)).toBe('twenty one');
    expect(spellNumber(463)).toBe('four hundred sixty three');
    expect(spellNumber(2012)).toBe('two thousand twelve');
    expect(spellNumber(171000)).toBe('171000');
  });

  it('treats en, en-GB and a missing language as English', () => {
    expect(isEnglish(undefined)).toBe(true);
    expect(isEnglish('en-GB')).toBe(true);
    expect(isEnglish('de')).toBe(false);
  });
});
