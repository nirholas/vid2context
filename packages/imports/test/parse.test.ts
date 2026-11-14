import { readFileSync } from 'node:fs';
import type { VideoContext } from '@vid2context/core';
import { parseSrv1, parseSrv3, parseVtt } from '@vid2context/provider-youtube';
import { describe, expect, it } from 'vitest';
import {
  clockToSec,
  languageFromFilename,
  looksLikeYouTubeTranscript,
  normalizeSegments,
  parseTranscriptText,
  spokenLabel,
} from '../src/parse.ts';

/** Real files from this repo: see test/fixtures/README.md for where each one comes from. */
const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const YT = 'providers/youtube/test/fixtures';
const srt = {
  apollo: repo('packages/ffmpeg/test/fixtures/apollo11-first-steps.en.srt'),
  podcast: repo('providers/podcast/test/fixtures/pc20-278-captions.srt'),
  speakers: repo('providers/podcast/test/fixtures/pnwr-20117890-transcript.srt'),
  japanese: repo('packages/core/test/chunk/fixtures/commons-ap11-final-approach.ja.srt'),
};
const vtt = {
  vimeo: repo('providers/native-transcripts/test/fixtures/vimeo-1133654544-de.vtt'),
  italics: repo('providers/native-transcripts/test/fixtures/vimeo-76979871-en.vtt'),
  rolling: repo('providers/native-transcripts/test/fixtures/youtube-QYRbx7PhiB8-rolling.en.vtt'),
  voices: repo('providers/podcast/test/fixtures/pnwr-20117890-transcript.vtt'),
};
const copy = {
  zoo: own('youtube-transcript-jNQXAC9IVRw.txt'),
  gwagon: own('youtube-transcript-cCPsdFdlshc.txt'),
  lecture: own('youtube-transcript-xAcTmDO6NTI.txt'),
};
const zooContext = JSON.parse(repo('tests/fixtures/contexts/youtube-jNQXAC9IVRw.json')) as VideoContext;

const crlf = (s: string) => s.replace(/\n/g, '\r\n');
const words = (texts: string[]) => texts.join(' ').split(/\s+/).filter(Boolean);

describe('format detection', () => {
  it('detects every format from the content alone, whatever the filename says', () => {
    expect(parseTranscriptText(vtt.vimeo).format).toBe('vtt');
    expect(parseTranscriptText(srt.apollo).format).toBe('srt');
    expect(parseTranscriptText(repo(`${YT}/timedtext-jNQXAC9IVRw-en.srv3.xml`)).format).toBe('srv3');
    expect(parseTranscriptText(repo(`${YT}/timedtext-jNQXAC9IVRw-en.srv1.xml`)).format).toBe('srv1');
    expect(parseTranscriptText(copy.zoo).format).toBe('youtube-transcript');
    // A misleading extension does not change the detected format.
    expect(parseTranscriptText(srt.apollo, { filename: 'notes.txt' }).format).toBe('srt');
    expect(parseTranscriptText(copy.zoo, { filename: 'captions.srt' }).format).toBe('youtube-transcript');
  });

  it('treats text with no timing as plain text, one segment per paragraph', () => {
    const paragraphs = zooContext.transcript.segments.map((s) => s.text).join('\n\n');
    const parsed = parseTranscriptText(paragraphs, { durationSec: zooContext.metadata.durationSec });
    expect(parsed.format).toBe('plain');
    expect(parsed.segments.map((s) => s.text)).toEqual(zooContext.transcript.segments.map((s) => s.text));
    expect(parsed.segments.every((s) => s.startSec === 0 && s.endSec === 19)).toBe(true);
  });

  it('returns no segments for markup and JSON that are not YouTube timedtext', () => {
    expect(parseTranscriptText(repo(`${YT}/timedtext-429-blocked.html`)).segments).toEqual([]);
    expect(parseTranscriptText(repo(`${YT}/player-jNQXAC9IVRw.json`)).segments).toEqual([]);
    expect(parseTranscriptText('   \n\n ').segments).toEqual([]);
  });
});

describe('SRT', () => {
  it('reads multi-line cues, drops cue numbers and keeps the timing, with no newline at the end of the file', () => {
    const { segments } = parseTranscriptText(srt.apollo);
    expect(segments).toHaveLength(7);
    expect(segments[0]).toEqual({ startSec: 0.5, endSec: 3.26, text: "I'm at the foot of the ladder." });
    expect(segments[1]?.text).toBe('The LEM footpads are only depressed in the surface about one or two inches,');
    expect(segments.at(-1)).toEqual({
      startSec: 47.772,
      endSec: 55.822,
      text: "That's one small step for [a] man, one giant leap for mankind.",
    });
  });

  it('parses CRLF files and a byte order mark exactly like LF files', () => {
    const lf = parseTranscriptText(srt.podcast);
    expect(lf.segments).toHaveLength(80);
    expect(parseTranscriptText(`\uFEFF${crlf(srt.podcast)}`)).toEqual(lf);
    expect(parseTranscriptText(srt.podcast.replace(/\n/g, '\r'))).toEqual(lf);
  });

  it('keeps speaker names that are part of the cue text, and non-Latin text', () => {
    expect(parseTranscriptText(srt.speakers).segments[0]?.text).toBe("James Cridland: Coming up, iHeart's Podcasts for Sale or");
    const ja = parseTranscriptText(srt.japanese);
    expect(ja.segments).toHaveLength(87);
    expect(ja.segments[0]).toEqual({ startSec: 6.66, endSec: 8.579, text: '高度 5,200フィート' });
  });

  it('takes the language from a tag in the filename', () => {
    expect(parseTranscriptText(srt.apollo, { filename: 'apollo11-first-steps.en.srt' }).language).toBe('en');
    expect(parseTranscriptText(srt.japanese, { filename: 'C:\\subs\\final-approach.ja.srt' }).language).toBe('ja');
    expect(parseTranscriptText(srt.apollo, { filename: 'apollo11-first-steps.srt' }).language).toBeUndefined();
  });
});

describe('WebVTT', () => {
  it('matches parseVtt from provider-youtube and reads the Language header', () => {
    const parsed = parseTranscriptText(vtt.rolling, { filename: 'whatever.de.vtt' });
    expect(parsed.language).toBe('en');
    expect(parsed.segments).toEqual(parseVtt(vtt.rolling));
    // Rolling auto-captions repeat the previous line; the repeats are dropped.
    expect(parsed.segments[0]?.text).toBe('hello everyone welcome to');
    expect(parsed.segments[1]?.text).not.toContain('hello everyone welcome to');
  });

  it('strips voice and italic tags', () => {
    const voices = parseTranscriptText(vtt.voices).segments;
    expect(voices[0]?.text).toBe("Coming up, iHeart's Podcasts for Sale or not?");
    expect(voices.some((s) => s.text.includes('<'))).toBe(false);
    const italics = parseTranscriptText(vtt.italics).segments;
    expect(italics[0]?.text).toBe("Here at Vimeo, there's always one thing on our minds:");
  });

  it('parses CRLF and BOM files exactly like LF files', () => {
    const lf = parseTranscriptText(vtt.vimeo);
    expect(lf.segments).toHaveLength(27);
    expect(lf.segments[0]).toEqual({ startSec: 2.377, endSec: 4.796, text: 'Willkommen zu REFRAME 2025.' });
    expect(parseTranscriptText(`\uFEFF${crlf(vtt.vimeo)}`)).toEqual(lf);
  });

  it('falls back to the filename language when the file has no Language header', () => {
    expect(parseTranscriptText(vtt.vimeo, { filename: 'vimeo-1133654544.de.vtt' }).language).toBe('de');
  });
});

describe('YouTube timedtext', () => {
  it('srv3 and srv1 bodies match the provider parsers, entities decoded', () => {
    const srv3 = repo(`${YT}/timedtext-jNQXAC9IVRw-en.srv3.xml`);
    const srv1 = repo(`${YT}/timedtext-jNQXAC9IVRw-en.srv1.xml`);
    expect(parseTranscriptText(srv3).segments).toEqual(parseSrv3(srv3));
    expect(parseTranscriptText(srv1).segments).toEqual(parseSrv1(srv1));
    // srv1 encodes entities twice (&amp;#39;).
    expect(parseTranscriptText(srv1).segments[3]?.text).toBe("and that's cool");
  });

  it('reads auto-caption srv3 with per-word timing', () => {
    const asr = repo(`${YT}/timedtext-cCPsdFdlshc-en-asr.srv3.xml`);
    const parsed = parseTranscriptText(asr);
    expect(parsed.format).toBe('srv3');
    expect(parsed.segments[0]?.text).toBe("so you're going to buy G wagon which");
  });
});

describe('YouTube "Show transcript" copy', () => {
  it('reads the panel text: timestamps run together with their spoken labels, chapter headings dropped', () => {
    const parsed = parseTranscriptText(copy.zoo, { durationSec: 19 });
    expect(parsed.format).toBe('youtube-transcript');
    expect(parsed.segments).toEqual([
      {
        startSec: 1,
        endSec: 7,
        text: 'All right, so here we are, in front of the elephants the cool thing about these guys is that they have really...',
      },
      { startSec: 7, endSec: 16, text: "really really long trunks and that's cool (baaaaaaaaaaahhh!!)" },
      { startSec: 16, endSec: 19, text: "and that's pretty much all there is to say" },
    ]);
  });

  it('has the same words as the creator caption track it was copied from', () => {
    const srv3 = parseSrv3(repo(`${YT}/timedtext-jNQXAC9IVRw-en.srv3.xml`));
    const parsed = parseTranscriptText(copy.zoo);
    expect(words(parsed.segments.map((s) => s.text))).toEqual(words(srv3.map((s) => s.text)));
  });

  it('reads an 18-minute auto-caption transcript with nine chapters', () => {
    const parsed = parseTranscriptText(copy.gwagon);
    expect(parsed.segments).toHaveLength(137);
    expect(parsed.segments[0]?.startSec).toBe(0);
    expect(parsed.segments[0]?.text.startsWith("so you're going to buy G wagon which year is best for you")).toBe(true);
    // "1:02" carries the label "1 minute, 2 seconds"; "16:00" carries "16 minutes".
    expect(parsed.segments.find((s) => s.startSec === 62)?.text.startsWith('first one the 2000 G500')).toBe(true);
    expect(parsed.segments.find((s) => s.startSec === 960)?.text.startsWith('coolers or 16 and newer')).toBe(true);
    expect(parsed.segments.some((s) => /^Chapter \d+:/.test(s.text) || /Chapter \d+: /.test(s.text))).toBe(false);
    expect(parsed.segments.some((s) => /^\d+ (seconds?|minutes?)/.test(s.text))).toBe(false);
    expect(parsed.segments.at(-1)?.endSec).toBe((parsed.segments.at(-1)?.startSec ?? 0) + 5);
  });

  it('reads hour timestamps and drops lines with no text', () => {
    const parsed = parseTranscriptText(copy.lecture, { durationSec: 3810 });
    // 545 rows in the panel, two of them with no text (0:04 and 1:03:18).
    expect(parsed.segments).toHaveLength(543);
    expect(parsed.segments.find((s) => s.startSec === 3607)?.text).toBe("I've just created this.");
    expect(parsed.segments.at(-1)).toMatchObject({ startSec: 3792, endSec: 3810 });
    expect(parsed.segments.at(-1)?.text.startsWith("All right, so that's the end of today's lecture.")).toBe(true);
    expect(parsed.segments.some((s) => s.text.includes('hour,'))).toBe(false);
  });

  it('is recognised on CRLF text too', () => {
    expect(parseTranscriptText(crlf(copy.gwagon)).segments).toEqual(parseTranscriptText(copy.gwagon).segments);
  });

  it('is not mistaken for plain text, and plain text is not mistaken for it', () => {
    expect(looksLikeYouTubeTranscript(copy.lecture)).toBe(true);
    expect(looksLikeYouTubeTranscript(zooContext.transcript.segments.map((s) => s.text).join('\n'))).toBe(false);
  });
});

describe('helpers', () => {
  it('spokenLabel matches the labels in the recorded panel text', () => {
    expect(spokenLabel(0)).toBe('0 seconds');
    expect(spokenLabel(1)).toBe('1 second');
    expect(spokenLabel(62)).toBe('1 minute, 2 seconds');
    expect(spokenLabel(960)).toBe('16 minutes');
    expect(spokenLabel(3607)).toBe('1 hour, 7 seconds');
    expect(spokenLabel(3792)).toBe('1 hour, 3 minutes, 12 seconds');
    for (const label of [
      '0 seconds',
      '1 minute, 2 seconds',
      '16 minutes',
      '1 hour, 7 seconds',
      '1 hour, 3 minutes, 12 seconds',
    ]) {
      expect(copy.gwagon.includes(label) || copy.lecture.includes(label)).toBe(true);
    }
  });

  it('clockToSec reads SRT, VTT and panel timestamps', () => {
    expect(clockToSec('00:00:47,772')).toBe(47.772);
    expect(clockToSec('01:02.5')).toBe(62.5);
    expect(clockToSec('1:00:07')).toBe(3607);
    expect(clockToSec('7')).toBeNaN();
  });

  it('languageFromFilename only takes two-letter primary tags', () => {
    expect(languageFromFilename('talk.pt-BR.vtt')).toBe('pt-BR');
    expect(languageFromFilename('talk.zh_Hans.srt')).toBe('zh-Hans');
    expect(languageFromFilename('notes.the.txt')).toBeUndefined();
  });

  it('normalizeSegments sorts and fills missing ends from the next start, the duration, or start + 5', () => {
    const copied = parseTranscriptText(copy.zoo).segments;
    const shuffled = [copied[2], copied[0], copied[1]].map((s) => ({ startSec: s?.startSec ?? 0, text: s?.text ?? '' }));
    expect(normalizeSegments(shuffled, 19).map((s) => [s.startSec, s.endSec])).toEqual([
      [1, 7],
      [7, 16],
      [16, 19],
    ]);
    expect(normalizeSegments(shuffled).at(-1)?.endSec).toBe(21);
    // A given end before the start is ignored.
    expect(normalizeSegments([{ startSec: 16, endSec: 2, text: 'x' }], 19)[0]?.endSec).toBe(19);
  });
});
