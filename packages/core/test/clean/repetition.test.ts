import { describe, expect, it } from 'vitest';
import { guardRepetition } from '../../src/clean/index.ts';
import { context, deepFreeze, verboseSegments } from './helpers.ts';

describe('guardRepetition', () => {
  it('collapses the real OVH Whisper loop (one token 19 times) to two occurrences and reports it', () => {
    const source = deepFreeze(verboseSegments('ovh-whisper-loop.verbose.json'));
    expect(source[0]?.text).toBe('ギ'.repeat(19));
    const { segments, report } = guardRepetition(source);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('ギギ');
    expect(segments[0]?.confidence).toBe(0.2);
    expect(segments[0]?.startSec).toBe(0);
    expect(segments[0]?.endSec).toBe(20);
    expect(report.rewritten).toBe(1);
    expect(report.examples).toEqual([{ atSec: 0, before: 'ギ'.repeat(19), after: 'ギギ', rule: 'repetition-loop' }]);
  });

  it('leaves the 521 real auto-caption segments alone, natural repeats included', () => {
    const source = deepFreeze(context('youtube-cCPsdFdlshc.json').transcript.segments);
    const natural = source.filter((s) => /\b(it it it|really really|yes yes|I I)\b/.test(s.text));
    expect(natural.length).toBeGreaterThanOrEqual(4);
    const { segments, report } = guardRepetition(source);
    expect(segments).toEqual(source);
    expect(report).toMatchObject({ removed: 0, rewritten: 0, flagged: 0 });
  });

  it('leaves the real Apollo 11 transcript alone', () => {
    const source = verboseSegments(
      '../../../../../providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json',
    );
    const { segments, report } = guardRepetition(source);
    expect(segments).toEqual(source);
    expect(report.examples).toEqual([]);
  });

  it('flags, and keeps, the real sign-off hallucination OVH produced over 30 s of static', () => {
    const source = deepFreeze(verboseSegments('ovh-whisper-tail-hallucination.verbose.json'));
    expect(source.map((s) => s.text)).toEqual([
      "I'm going to step off the limb now.",
      "That's one small step for man, one giant leap for mankind.",
      "I'll see you next time.",
    ]);
    const { segments, report } = guardRepetition(source);
    expect(segments.map((s) => s.text)).toEqual(source.map((s) => s.text));
    expect(segments[2]?.confidence).toBe(0.2);
    expect(segments[0]?.confidence).toBeUndefined();
    expect(segments[1]?.confidence).toBeUndefined();
    expect(report.flagged).toBe(1);
    expect(report.examples[0]).toMatchObject({ rule: 'hallucination-tail', atSec: 37 });
  });

  it('can skip hallucination flagging', () => {
    const { report } = guardRepetition(verboseSegments('ovh-whisper-tail-hallucination.verbose.json'), {
      flagHallucinations: false,
    });
    expect(report.flagged).toBe(0);
  });
});
