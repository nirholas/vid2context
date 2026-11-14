import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../../src/clean/index.ts';
import { estimateTokens, segmentsToText } from '../../src/index.ts';
import { bareWords, context, deepFreeze, sttTranscript, verboseSegments } from './helpers.ts';

describe('cleanTranscript', () => {
  it('cleans the real cCPsdFdlshc auto-captions without touching the frozen input', async () => {
    const source = deepFreeze(context('youtube-cCPsdFdlshc.json').transcript);
    const snapshot = JSON.stringify(source);
    const { transcript, report } = await cleanTranscript(source, { fillers: true });
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(report.steps).toEqual(['normalize', 'dedupe-rolling', 'restore-sentences', 'remove-fillers']);
    expect(transcript.origin).toBe(source.origin);
    expect(transcript.producer).toBe(source.producer);
    expect(transcript.ref).toEqual(source.ref);

    // Every original word is still there except the 2-word rolling duplicate and the 23 fillers.
    const before = bareWords(source.segments);
    const after = bareWords(transcript.segments);
    expect(after.length).toBe(before.length - 2 - 23);

    const tokensBefore = estimateTokens(segmentsToText(source.segments));
    const tokensAfter = estimateTokens(segmentsToText(transcript.segments));
    console.error(`cCPsdFdlshc estimated tokens: ${tokensBefore} raw -> ${tokensAfter} cleaned`);
    expect(tokensAfter).toBeLessThan(tokensBefore);
  });

  it('runs the repetition guard for speech-to-text transcripts only', async () => {
    const loop = deepFreeze(sttTranscript(verboseSegments('ovh-whisper-loop.verbose.json')));
    const { transcript, report } = await cleanTranscript(loop);
    expect(report.steps).toContain('guard-repetition');
    expect(transcript.segments[0]?.text).toBe('ギギ');

    const auto = context('youtube-cCPsdFdlshc.json').transcript;
    expect((await cleanTranscript(auto)).report.steps).not.toContain('guard-repetition');
  });

  it('leaves the punctuated creator captions of jNQXAC9IVRw as they are', async () => {
    const source = deepFreeze(context('youtube-jNQXAC9IVRw.json').transcript);
    const { transcript, report } = await cleanTranscript(source);
    expect(transcript.segments).toEqual(source.segments);
    expect(report.rewritten).toBe(0);
  });
});
