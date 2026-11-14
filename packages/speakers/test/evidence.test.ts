import { describe, expect, it } from 'vitest';
import { isPlausibleName, nameIsGrounded, nameTokens, normalizeText, quoteAppearsNear } from '../src/index.ts';
import { CLIPS, loadContext } from './fixture-context.ts';

// Real diarized transcript: Deepgram nova-3 on the 1969 Nixon to Apollo 11 call (see fixtures/README.md).
const call = loadContext(CLIPS.call);
const segs = call.transcript.segments;

describe('normalizeText', () => {
  it('folds case, punctuation, curly apostrophes and whitespace', () => {
    expect(normalizeText('  Man’s   WORLD. ')).toBe("man's world");
    expect(normalizeText('Go Go ahead, ahead, mister')).toBe('go go ahead ahead mister');
  });
});

describe('quoteAppearsNear', () => {
  it('finds a quote at the time it was spoken', () => {
    expect(quoteAppearsNear(segs, 'This is Houston out.', 51)).toBe(true);
    expect(quoteAppearsNear(segs, 'hello, neil and buzz', 54)).toBe(true);
  });

  it('finds a quote that spans two segments', () => {
    // "the heavens" (88.32 s) and "have become a part of man's world." (89.52 s) are separate utterances.
    expect(quoteAppearsNear(segs, 'the heavens have become a part of man’s world', 88.3)).toBe(true);
  });

  it('rejects a quote cited far from where it was said', () => {
    expect(quoteAppearsNear(segs, 'This is Houston out.', 150)).toBe(false);
    expect(quoteAppearsNear(segs, 'This is Houston out.', 150, 120)).toBe(true);
  });

  it('rejects words that are not in the transcript and fragments too short to mean anything', () => {
    // The audio says "Oval Room"; the recognizer wrote "over room". Only the transcript's words count.
    expect(quoteAppearsNear(segs, 'from the Oval Room at the White House', 55.6)).toBe(false);
    expect(quoteAppearsNear(segs, 'from the over room at the White House', 55.6)).toBe(true);
    expect(quoteAppearsNear(segs, 'I', 13)).toBe(false);
    expect(quoteAppearsNear(segs, 'ahead mister president', Number.NaN)).toBe(false);
  });
});

describe('names', () => {
  it('rejects diarization labels and role words', () => {
    expect(isPlausibleName('Speaker 2')).toBe(false);
    expect(isPlausibleName('Speaker A')).toBe(false);
    expect(isPlausibleName('Host')).toBe(false);
    expect(isPlausibleName('Unknown speaker')).toBe(false);
    expect(isPlausibleName('President Nixon')).toBe(true);
    expect(isPlausibleName('Dr. Lee')).toBe(true);
  });

  it('drops honorifics when matching', () => {
    expect(nameTokens('Mr. Richard Nixon')).toEqual(['richard', 'nixon']);
  });

  it('accepts a name only when the video itself mentions it', () => {
    expect(nameIsGrounded('Richard Nixon', segs, call.metadata)).toBe(true); // "Nixon" is in the title
    expect(nameIsGrounded('Neil Armstrong', segs, call.metadata)).toBe(true); // "Neil" is in the transcript
    // The real CAPCOM that day, but the video never says so.
    expect(nameIsGrounded('Bruce McCandless', segs, call.metadata)).toBe(false);
  });
});
