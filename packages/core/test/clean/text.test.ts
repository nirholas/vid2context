import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSrv1, parseSrv3 } from '@vid2context/provider-youtube';
import { describe, expect, it } from 'vitest';
import {
  groupParagraphs,
  normalizeCaptionText,
  punctuationDensity,
  removeFillers,
  restoreSentences,
} from '../../src/clean/index.ts';
import { bareWords, context, deepFreeze, ROOT } from './helpers.ts';

const auto = deepFreeze(context('youtube-cCPsdFdlshc.json').transcript.segments);
const creator = deepFreeze(context('youtube-jNQXAC9IVRw.json').transcript.segments);

describe('normalizeCaptionText', () => {
  it('keeps the real creator captions as they are by default, sound description included', () => {
    const { segments, report } = normalizeCaptionText(creator);
    expect(segments).toEqual(creator);
    expect(report.rewritten).toBe(0);
  });

  it('removes a cue that is only a sound description with tags: remove', () => {
    const { segments, report } = normalizeCaptionText(creator, { tags: 'remove' });
    expect(segments.map((s) => s.text)).not.toContain('(baaaaaaaaaaahhh!!)');
    expect(segments).toHaveLength(creator.length - 1);
    expect(report.removed).toBe(1);
    expect(report.examples[0]).toMatchObject({ rule: 'tag-removed', before: '(baaaaaaaaaaahhh!!)', after: '' });
  });

  it('decodes entities in raw cue text the same way as the YouTube parser', () => {
    const xml = readFileSync(join(ROOT, 'providers/youtube/test/fixtures/timedtext-cCPsdFdlshc-en-asr.srv3.xml'), 'utf8');
    const raw = [...xml.matchAll(/<p t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => ({ startSec: Number(m[1]) / 1000, endSec: Number(m[1]) / 1000, text: (m[2] ?? '').replace(/<[^>]+>/g, '') }))
      .filter((s) => s.text.trim());
    const { segments } = normalizeCaptionText(raw);
    expect(raw[0]?.text).toContain('you&#39;re');
    expect(segments.map((s) => s.text)).toEqual(parseSrv3(xml).map((s) => s.text));
  });

  it('matches srv1 parsing on the double-encoded creator track after one more decode pass', () => {
    const xml = readFileSync(join(ROOT, 'providers/youtube/test/fixtures/timedtext-jNQXAC9IVRw-en.srv1.xml'), 'utf8');
    const once = parseSrv1(xml);
    expect(normalizeCaptionText(once).segments.map((s) => s.text)).toEqual(once.map((s) => s.text));
  });
});

describe('restoreSentences', () => {
  it('adds sentence capitals and ends to the real auto-captions without adding or removing words', () => {
    expect(punctuationDensity(auto)).toBe(0);
    const { segments, report } = restoreSentences(auto);
    expect(bareWords(segments)).toEqual(bareWords(auto));
    expect(segments[0]?.text.startsWith('So ')).toBe(true);
    // Cue gaps are clamped to zero by the parser, so only segment-initial discourse markers end sentences here.
    expect(segments.filter((s) => /[.]$/.test(s.text)).length).toBeGreaterThanOrEqual(5);
    expect(segments.find((s) => s.startSec === 36.239)?.text).toBe('click the link in the description right.');
    expect(segments.find((s) => s.startSec === 37.719)?.text).toBe('Now Joe thanks for being here man all');
    expect(report.rewritten).toBeGreaterThanOrEqual(10);
    // The pronoun I is capitalized in the real text ("I don't want you getting").
    expect(segments.some((s) => /\bI don't\b/.test(s.text))).toBe(true);
    expect(segments.every((s, i) => s.startSec === auto[i]?.startSec && s.endSec === auto[i]?.endSec)).toBe(true);
  });

  it('leaves the punctuated creator captions of jNQXAC9IVRw unchanged', () => {
    const { segments, report } = restoreSentences(creator);
    expect(segments).toEqual(creator);
    expect(report.rewritten).toBe(0);
  });

  it('ends a sentence before a discourse marker but not after a word like "the"', () => {
    const { segments } = restoreSentences(auto);
    for (let i = 0; i < segments.length - 1; i++) {
      const text = segments[i]?.text ?? '';
      if (/\b(the|a|and|of)\.$/i.test(text)) throw new Error(`sentence ended on a function word: ${text}`);
    }
  });
});

describe('removeFillers', () => {
  it('removes the real "uh" and "um" fillers and nothing else', () => {
    const { segments, report } = removeFillers(auto);
    const before = bareWords(auto);
    const after = bareWords(segments);
    const fillers = before.filter((w) => w === 'uh' || w === 'um');
    expect(fillers.length).toBe(23);
    expect(after).toEqual(before.filter((w) => w !== 'uh' && w !== 'um'));
    expect(after).toContain('like');
    expect(after).toContain('so');
    expect(report.rewritten + report.removed).toBeGreaterThan(0);
  });
});

describe('groupParagraphs', () => {
  it('groups the real auto-captions into paragraphs of about 120 words that cover every word', () => {
    const sentences = restoreSentences(auto).segments;
    const paras = groupParagraphs(sentences);
    const counts = paras.map((p) => p.text.split(/\s+/).length);
    expect(paras.length).toBeGreaterThan(20);
    expect(Math.max(...counts)).toBeLessThanOrEqual(180);
    expect(paras.join(' ')).toBeTruthy();
    expect(paras.flatMap((p) => p.text.split(/\s+/)).length).toBe(sentences.flatMap((s) => s.text.split(/\s+/)).length);
    expect(paras[0]?.startSec).toBe(auto[0]?.startSec);
    expect(paras.at(-1)?.endSec).toBe(auto.at(-1)?.endSec);
  });

  it('starts a new paragraph at a pause of 1.5 s or more', () => {
    const paras = groupParagraphs(creator);
    // jNQXAC9IVRw has a 1.958 s pause after "in front of the elephants".
    expect(paras[0]?.text).toBe('All right, so here we are, in front of the elephants');
    expect(paras.length).toBe(2);
  });
});
