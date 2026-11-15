/**
 * The subtitle suite: ass, ttml, sbv, lrc and csv, plus the options every
 * timed format shares (offsetSec, maxLineChars, maxLines, secondary) and
 * speaker labels. Everything renders real data:
 * - tests/fixtures/contexts/*.json, real VideoContext output;
 * - the real German creator track of "Me at the zoo" (YouTube srv3, recorded
 *   in providers/youtube/test/fixtures) as a second language with its own timings;
 * - the real German LLM translation of the first 30 G-Wagon segments
 *   (packages/translate/test/fixtures), which keeps the source timings;
 * - the real Deepgram nova-3 diarized utterances of the Nixon and Apollo 11
 *   call (packages/speakers/test/fixtures), labelled `Speaker N` the way the
 *   cloudflare-ai stt provider labels them.
 */
import { describe, expect, it } from 'vitest';
import { Vid2ContextError } from '../../src/errors.ts';
import { csvField, csvSafeText } from '../../src/format/csv.ts';
import { buildCues, type Cue, resolveLayout } from '../../src/format/cues.ts';
import { formatters, render, shiftSegments } from '../../src/format/index.ts';
import { cleanText } from '../../src/format/paragraphs.ts';
import { escapeXml } from '../../src/format/ttml.ts';
import type { Segment, Transcript, VideoContext } from '../../src/types.ts';
import { loadContext, parseSrt, parseVtt, readRepoFile, sourceWords } from './helpers.ts';

const fixtures = { jNQXAC9IVRw: loadContext('jNQXAC9IVRw'), cCPsdFdlshc: loadContext('cCPsdFdlshc') };
const zoo = fixtures.jNQXAC9IVRw;
const gwagon = fixtures.cCPsdFdlshc;

/** The German creator track of "Me at the zoo", parsed from the recorded srv3 file. */
function zooGerman(): Transcript {
  const xml = readRepoFile('providers/youtube/test/fixtures/timedtext-jNQXAC9IVRw-de.srv3.xml');
  const segments = [...xml.matchAll(/<p t="(\d+)" d="(\d+)">([^<]*)<\/p>/g)].map((m) => ({
    startSec: Number(m[1]) / 1000,
    endSec: (Number(m[1]) + Number(m[2])) / 1000,
    text: m[3] as string,
  }));
  return { ...zoo.transcript, language: 'de', segments };
}

/** The recorded German translation of the first 30 G-Wagon segments, on the source timings. */
function gwagonGerman(): { source: VideoContext; secondary: Transcript } {
  const rec = JSON.parse(readRepoFile('packages/translate/test/fixtures/llm-de-whole-001.json'));
  const content = JSON.parse(JSON.parse(rec.response.body).choices[0].message.content) as {
    segments: { id: number; text: string }[];
  };
  const src = gwagon.transcript.segments.slice(0, 30);
  const byId = new Map(content.segments.map((s) => [s.id, s.text]));
  return {
    source: { ...gwagon, transcript: { ...gwagon.transcript, segments: src } },
    secondary: {
      ...gwagon.transcript,
      language: 'de',
      translated: true,
      segments: src.map((s, i) => ({ ...s, text: byId.get(i) ?? '' })),
    },
  };
}

/** The Nixon call as a VideoContext transcript: Deepgram utterances, speakers as `Speaker N`. */
function nixonCall(): VideoContext {
  const rec = JSON.parse(readRepoFile('packages/speakers/test/fixtures/nova3-nixon-armstrong-call.json'));
  const utterances = rec.result.results.utterances as { start: number; end: number; transcript: string; speaker: number }[];
  const segments: Segment[] = utterances.map((u) => ({
    startSec: u.start,
    endSec: u.end,
    text: u.transcript,
    speaker: `Speaker ${u.speaker}`,
  }));
  return { ...zoo, transcript: { ...zoo.transcript, origin: 'stt', producer: 'cloudflare-ai-stt', segments } };
}

const ms = (h: string, m: string, s: string, frac: string, scale: number) =>
  ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(frac) * scale;

/** Minimal XML well-formedness check: balanced tags, quoted attributes, only known entities in text. */
function xmlProblems(src: string): string[] {
  const problems: string[] = [];
  const body = src.replace(/^<\?xml[^?]*\?>\n/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  for (const m of body.matchAll(re)) {
    const [, close, name, , selfClose, text, stray] = m;
    if (stray) problems.push(`raw "<" at ${m.index}`);
    else if (text !== undefined) {
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(text)) problems.push(`raw "&" at ${m.index}`);
    } else if (close) {
      if (stack.pop() !== name) problems.push(`mismatched </${name}> at ${m.index}`);
    } else if (!selfClose) stack.push(name as string);
  }
  if (stack.length) problems.push(`unclosed: ${stack.join(', ')}`);
  return problems;
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** RFC 4180 parser (CRLF records, quoted fields with doubled quotes). Throws on malformed input. */
function parseCsv(src: string): string[][] {
  if (!src.endsWith('\r\n')) throw new Error('CSV: must end with CRLF');
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  while (i < src.length) {
    let value = '';
    if (src[i] === '"') {
      i++;
      for (;;) {
        if (i >= src.length) throw new Error('CSV: unterminated quote');
        if (src[i] === '"' && src[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (src[i] === '"') {
          i++;
          break;
        } else value += src[i++];
      }
    } else {
      while (i < src.length && src[i] !== ',' && src[i] !== '\r') {
        if (src[i] === '"' || src[i] === '\n') throw new Error(`CSV: bare quote or LF at ${i}`);
        value += src[i++];
      }
    }
    row.push(value);
    if (src[i] === ',') i++;
    else if (src.startsWith('\r\n', i)) {
      rows.push(row);
      row = [];
      i += 2;
    } else throw new Error(`CSV: expected separator at ${i}`);
  }
  return rows;
}

const words = (lines: string[]) => lines.join(' ').split(/\s+/).filter(Boolean);
const cueWords = (cues: Cue[]) => cues.flatMap((c) => words(c.lines));

describe('registry entries', () => {
  it('declares the new formats with their extensions and mime types', () => {
    const meta = Object.fromEntries(
      ['ass', 'ttml', 'sbv', 'lrc', 'csv'].map((id) => [id, [formatters[id]?.extension, formatters[id]?.mimeType]]),
    );
    expect(meta).toEqual({
      ass: ['ass', 'text/x-ssa; charset=utf-8'],
      ttml: ['ttml', 'application/ttml+xml'],
      sbv: ['sbv', 'text/plain; charset=utf-8'],
      lrc: ['lrc', 'text/plain; charset=utf-8'],
      csv: ['csv', 'text/csv; charset=utf-8'],
    });
    const timed = Object.values(formatters)
      .filter((f) => f.timed)
      .map((f) => `${f.id}:${f.timed}`);
    expect(timed.sort()).toEqual([
      'ass:always',
      'csv:always',
      'lrc:always',
      'sbv:always',
      'srt:always',
      'text:timestamps',
      'ttml:always',
      'vtt:always',
    ]);
  });
});

describe.each(Object.entries(fixtures))('%s in every subtitle format', (_id, ctx) => {
  const segs = ctx.transcript.segments;
  const prefixed = buildCues(segs, true);
  const plain = buildCues(segs, false);

  it('ass: three sections in order, one Dialogue per cue, valid times and escaping', () => {
    const out = render(ctx, 'ass');
    const sections = out.match(/^\[[^\]]+\]$/gm);
    expect(sections).toEqual(['[Script Info]', '[V4+ Styles]', '[Events]']);
    expect(out).toMatch(/^ScriptType: v4\.00\+$/m);
    expect(out).toMatch(/^PlayResX: 1920$/m);
    expect(out).toMatch(/^PlayResY: 1080$/m);
    expect(out).toMatch(/^Style: Default,/m);
    const styleFields = out.match(/^Format: Name,.*$/m)?.[0].split(',').length;
    for (const style of out.match(/^Style: .*$/gm) ?? []) expect(style.split(',').length).toBe(styleFields);
    const dialogues = out.match(/^Dialogue: .*$/gm) ?? [];
    expect(dialogues).toHaveLength(plain.length);
    let prevEnd = 0;
    dialogues.forEach((d, i) => {
      const f = d.slice('Dialogue: '.length).split(',');
      const t1 = /^(\d+):([0-5]\d):([0-5]\d)\.(\d\d)$/.exec(f[1] ?? '');
      const t2 = /^(\d+):([0-5]\d):([0-5]\d)\.(\d\d)$/.exec(f[2] ?? '');
      expect(t1, d).not.toBeNull();
      expect(t2, d).not.toBeNull();
      const start = ms(t1?.[1] as string, t1?.[2] as string, t1?.[3] as string, t1?.[4] as string, 10);
      const end = ms(t2?.[1] as string, t2?.[2] as string, t2?.[3] as string, t2?.[4] as string, 10);
      expect(end).toBeGreaterThan(start);
      expect(start).toBeGreaterThanOrEqual(prevEnd);
      expect(Math.abs(start - (plain[i] as Cue).startMs)).toBeLessThanOrEqual(10);
      prevEnd = end;
      expect(f[3]).toBe('Default');
      const text = f.slice(9).join(',');
      expect(text.replace(/\\[{}]/g, ''), d).not.toMatch(/[{}]/);
      expect(text.split('\\N')).toEqual((plain[i] as Cue).lines);
    });
  });

  it('ttml: well formed, one <p> per cue, every word kept', () => {
    const out = render(ctx, 'ttml');
    expect(xmlProblems(out)).toEqual([]);
    expect(out).toContain(`<tt xmlns="http://www.w3.org/ns/ttml"`);
    expect(out).toContain(`xml:lang="${ctx.transcript.language}"`);
    const ps = [...out.matchAll(/<p begin="(\d{2}):(\d{2}):(\d{2})\.(\d{3})" end="(\d{2}):(\d{2}):(\d{2})\.(\d{3})">(.*)<\/p>/g)];
    expect(ps).toHaveLength(prefixed.length);
    expect(out.match(/<p[ >]/g)).toHaveLength(prefixed.length);
    ps.forEach((p, i) => {
      const [, h1, m1, s1, f1, h2, m2, s2, f2] = p as unknown as string[];
      expect(ms(h1 as string, m1 as string, s1 as string, f1 as string, 1)).toBe((prefixed[i] as Cue).startMs);
      expect(ms(h2 as string, m2 as string, s2 as string, f2 as string, 1)).toBe((prefixed[i] as Cue).endMs);
    });
    const text = ps.flatMap((p) => (p[9] as string).split('<br/>').map(unescapeXml));
    expect(words(text)).toEqual(sourceWords(segs));
  });

  it('sbv: H:MM:SS.mmm,H:MM:SS.mmm blocks, one per cue, same timings as srt', () => {
    const out = render(ctx, 'sbv');
    expect(out.endsWith('\n') && !out.endsWith('\n\n')).toBe(true);
    const blocks = out.slice(0, -1).split('\n\n');
    expect(blocks).toHaveLength(prefixed.length);
    const srt = parseSrt(render(ctx, 'srt'));
    blocks.forEach((b, i) => {
      const [time, ...lines] = b.split('\n');
      const t = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{3}),(\d+):([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(time ?? '');
      expect(t, time).not.toBeNull();
      const [, h1, m1, s1, f1, h2, m2, s2, f2] = t as unknown as string[];
      expect(ms(h1 as string, m1 as string, s1 as string, f1 as string, 1)).toBe(srt[i]?.startMs);
      expect(ms(h2 as string, m2 as string, s2 as string, f2 as string, 1)).toBe(srt[i]?.endMs);
      expect(lines).toEqual(srt[i]?.lines);
    });
  });

  it('lrc: header tags, one [mm:ss.xx] line per cue in time order, clear marks only at gaps', () => {
    const out = render(ctx, 'lrc');
    const rows = out.trimEnd().split('\n');
    expect(rows[0]).toBe(`[ti:${cleanText(ctx.metadata.title)}]`);
    expect(rows[1]).toBe(`[ar:${ctx.metadata.channel?.name}]`);
    const dur = Math.round(ctx.metadata.durationSec as number);
    expect(rows[2]).toBe(`[length:${String(Math.floor(dur / 60)).padStart(2, '0')}:${String(dur % 60).padStart(2, '0')}]`);
    const timed = rows.slice(3).map((r) => {
      const m = /^\[(\d{2,}):([0-5]\d)\.(\d{2})\](.*)$/.exec(r);
      expect(m, r).not.toBeNull();
      return { at: (Number(m?.[1]) * 60 + Number(m?.[2])) * 1000 + Number(m?.[3]) * 10, text: m?.[4] as string };
    });
    const lines = timed.filter((t) => t.text);
    expect(lines.map((l) => l.text)).toEqual(prefixed.map((c) => c.lines.join(' ')));
    for (let i = 1; i < timed.length; i++) expect(timed[i]?.at).toBeGreaterThanOrEqual(timed[i - 1]?.at as number);
    const gaps = prefixed.filter((c, i) => !prefixed[i + 1] || (prefixed[i + 1] as Cue).startMs - c.endMs >= 1000).length;
    expect(timed.length - lines.length).toBe(gaps);
  });

  it('csv: header, one row per segment, RFC 4180 quoting that parses back to the text', () => {
    const out = render(ctx, 'csv');
    const rows = parseCsv(out);
    expect(rows[0]).toEqual(['start', 'end', 'speaker', 'text']);
    const kept = segs.filter((s) => cleanText(s.text));
    expect(rows).toHaveLength(kept.length + 1);
    rows.slice(1).forEach((r, i) => {
      const s = kept[i] as Segment;
      expect(r).toEqual([s.startSec.toFixed(3), s.endSec.toFixed(3), '', csvSafeText(cleanText(s.text))]);
    });
  });
});

describe('csv quoting', () => {
  it('quotes a real caption that holds commas', () => {
    // "All right, so here we are, in front of the elephants" is the first caption of "Me at the zoo".
    const first = cleanText(zoo.transcript.segments[0]?.text ?? '');
    expect(first).toContain(',');
    expect(render(zoo, 'csv').split('\r\n')[1]).toBe(`1.200,3.360,,"${first}"`);
  });

  it('follows RFC 4180 for quotes and line breaks, and leaves plain fields bare', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a\r\nb')).toBe('"a\r\nb"');
    expect(csvField('a\nb')).toBe('"a\nb"');
    expect(parseCsv(`${['x,y', 'say "hi"', ''].map(csvField).join(',')}\r\n`)).toEqual([['x,y', 'say "hi"', '']]);
  });

  it('neutralizes spreadsheet formulas but keeps a dialogue dash', () => {
    expect(csvSafeText('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvSafeText('+1')).toBe("'+1");
    expect(csvSafeText('@cmd')).toBe("'@cmd");
    expect(csvSafeText('-2+3')).toBe("'-2+3");
    expect(csvSafeText('- Hi there')).toBe('- Hi there');
    expect(csvSafeText('so here we are')).toBe('so here we are');
  });
});

describe('escaping', () => {
  it('ttml escapes markup characters and drops what XML forbids', () => {
    const withAmp: VideoContext = {
      ...gwagon,
      transcript: { ...gwagon.transcript, segments: [{ startSec: 0, endSec: 2, text: gwagon.metadata.title }] },
    };
    const out = render(withAmp, 'ttml');
    expect(out).toContain('Best &amp; Worst G-Wagon Years');
    expect(xmlProblems(out)).toEqual([]);
    expect(escapeXml('a<b>"c"\u0001\ufffe')).toBe('a&lt;b&gt;&quot;c&quot;');
  });

  it('ass escapes override braces and backslashes', () => {
    const title: VideoContext = {
      ...gwagon,
      transcript: {
        ...gwagon.transcript,
        segments: [{ startSec: 0, endSec: 2, text: `${gwagon.metadata.title} {\\b1} \\N` }],
      },
    };
    const dialogue = render(title, 'ass').match(/^Dialogue: .*$/m)?.[0] ?? '';
    expect(dialogue).toContain('\\{\\\u2060b1\\}');
    expect(dialogue).toContain('\\\u2060N');
    expect(dialogue.split('\\N')).toHaveLength(2);
  });
});

describe('offsetSec', () => {
  const segs = gwagon.transcript.segments;

  it('shifts every cue of every timed format by the offset', () => {
    const base = parseSrt(render(gwagon, 'srt'));
    const later = parseSrt(render(gwagon, 'srt', { offsetSec: 2.5 }));
    expect(later.map((c) => [c.startMs - 2500, c.endMs - 2500])).toEqual(base.map((c) => [c.startMs, c.endMs]));
    const vtt = parseVtt(render(gwagon, 'vtt', { offsetSec: 2.5 })).cues;
    expect(vtt.map((c) => [c.startMs, c.endMs])).toEqual(later.map((c) => [c.startMs, c.endMs]));
    const csv = parseCsv(render(gwagon, 'csv', { offsetSec: 2.5 }));
    expect(csv[1]?.slice(0, 2)).toEqual([(segs[0]?.startSec ?? 0) + 2.5, (segs[0]?.endSec ?? 0) + 2.5].map((n) => n.toFixed(3)));
    expect(render(zoo, 'text', { timestamps: true, offsetSec: 60 })).toMatch(/^\[1:01\] All right/);
  });

  it('drops cues that end at or before 0 and clamps the one that straddles 0', () => {
    // The third segment of the G-Wagon video runs 3.919 to 4.96 s; shift so it straddles 0.
    const offset = -4.5;
    const shifted = shiftSegments(segs, offset);
    expect(shifted).toHaveLength(segs.filter((s) => s.endSec + offset > 0).length);
    expect(shifted[0]).toEqual({ ...segs[2], startSec: 0, endSec: (segs[2]?.endSec ?? 0) + offset });
    expect(shifted[1]?.startSec).toBeCloseTo((segs[3]?.startSec ?? 0) + offset, 9);
    const srt = parseSrt(render(gwagon, 'srt', { offsetSec: offset }));
    expect(srt[0]?.startMs).toBe(0);
    expect(words(srt.flatMap((c) => c.lines))).toEqual(sourceWords(segs.slice(2)));
    const sbv = render(gwagon, 'sbv', { offsetSec: offset });
    expect(sbv.startsWith('0:00:00.000,')).toBe(true);
    expect(render(gwagon, 'lrc', { offsetSec: offset }).split('\n')[3]).toMatch(/^\[00:00\.00\]/);
    expect(render(gwagon, 'ass', { offsetSec: offset }).match(/^Dialogue: 0,0:00:00\.00,/m)).not.toBeNull();
    expect(render(gwagon, 'ttml', { offsetSec: offset })).toContain('<p begin="00:00:00.000"');
  });

  it('leaves untimed formats, and text without timestamps, alone', () => {
    for (const id of ['json', 'markdown', 'pack']) expect(render(zoo, id, { offsetSec: 5 })).toBe(render(zoo, id));
    expect(render(zoo, 'text', { offsetSec: -100 })).toBe(render(zoo, 'text'));
  });

  it('does not change the input and refuses an offset that is not a number', () => {
    const before = JSON.stringify(gwagon.transcript.segments);
    render(gwagon, 'srt', { offsetSec: -10 });
    expect(JSON.stringify(gwagon.transcript.segments)).toBe(before);
    expect(() => render(zoo, 'srt', { offsetSec: Number.NaN })).toThrow(Vid2ContextError);
    expect(() => shiftSegments(segs, Number.POSITIVE_INFINITY)).toThrow(/offsetSec/);
    expect(shiftSegments(segs, 0)).toEqual(segs);
  });
});

describe('maxLineChars and maxLines', () => {
  const segs = gwagon.transcript.segments;
  const check = (lines: string[][], max: number, maxLines: number) => {
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(maxLines);
      for (const line of l) expect(line.length).toBeLessThanOrEqual(max);
    }
  };

  for (const [maxLineChars, maxLines] of [
    [20, 2],
    [32, 1],
    [30, 3],
    [60, 4],
  ] as const) {
    it(`wraps to ${maxLines} line(s) of ${maxLineChars} characters in srt, sbv and ass, keeping every word`, () => {
      const srt = parseSrt(render(gwagon, 'srt', { maxLineChars, maxLines }));
      check(
        srt.map((c) => c.lines),
        maxLineChars,
        maxLines,
      );
      expect(words(srt.flatMap((c) => c.lines))).toEqual(sourceWords(segs));
      const sbv = render(gwagon, 'sbv', { maxLineChars, maxLines })
        .trimEnd()
        .split('\n\n')
        .map((b) => b.split('\n').slice(1));
      expect(sbv).toEqual(srt.map((c) => c.lines));
      const ass = (render(gwagon, 'ass', { maxLineChars, maxLines }).match(/^Dialogue: .*$/gm) ?? []).map((d) =>
        d.split(',').slice(9).join(',').split('\\N'),
      );
      check(ass, maxLineChars, maxLines);
    });
  }

  it('narrower lines need more cues than the default', () => {
    expect(buildCues(segs, false, { maxLineChars: 20 }).length).toBeGreaterThan(buildCues(segs, false).length);
    expect(buildCues(segs, false, { maxLineChars: 42, maxLines: 2 })).toEqual(buildCues(segs, false));
  });

  it('clamps out-of-range values and refuses non-numbers', () => {
    expect(resolveLayout({})).toEqual({ maxLineChars: 42, maxLines: 2 });
    expect(resolveLayout({ maxLineChars: 3, maxLines: 0 })).toEqual({ maxLineChars: 10, maxLines: 1 });
    expect(resolveLayout({ maxLineChars: 1000, maxLines: 9 })).toEqual({ maxLineChars: 200, maxLines: 4 });
    expect(resolveLayout({ maxLineChars: 30.6 })).toEqual({ maxLineChars: 31, maxLines: 2 });
    expect(() => render(zoo, 'srt', { maxLines: Number.NaN })).toThrow(/maxLines/);
  });
});

describe('secondary (bilingual subtitles)', () => {
  const de = zooGerman();
  const deWords = sourceWords(de.segments);

  it('the German track overlaps the English one but has its own timings', () => {
    expect(de.segments).toHaveLength(4);
    expect(de.segments.map((s) => s.startSec)).not.toEqual(zoo.transcript.segments.map((s) => s.startSec));
  });

  it('srt, vtt and sbv show each German segment once, under the English text it overlaps most', () => {
    const plain = parseSrt(render(zoo, 'srt'));
    const both = parseSrt(render(zoo, 'srt', { secondary: de }));
    expect(both.map((c) => [c.startMs, c.endMs])).toEqual(plain.map((c) => [c.startMs, c.endMs]));
    const extra = both.flatMap((c, i) => c.lines.slice(plain[i]?.lines.length));
    expect(words(extra)).toEqual(deWords);
    // 0 to 5.067 s overlaps the first caption (1.2 to 3.36 s) only.
    expect(both[0]?.lines.slice(-1)).toEqual(['Also hier sind wir vor den Elefanten.']);
    // 5.067 to 12.467 s overlaps "really really long trunks" (7.974 to 12.616 s) the most.
    const trunks = both.findIndex((c) => c.lines[0] === 'really really long trunks');
    expect(both[trunks]?.lines.slice(1).join(' ')).toBe(cleanText(de.segments[1]?.text ?? ''));
    const vtt = parseVtt(render(zoo, 'vtt', { secondary: de }));
    expect(vtt.cues.map((c) => c.lines)).toEqual(both.map((c) => c.lines));
    expect(vtt.notes[0]).toContain('Second language (de): creator captions from youtube-captions');
    const sbv = render(zoo, 'sbv', { secondary: de })
      .trimEnd()
      .split('\n\n')
      .map((b) => b.split('\n').slice(1));
    expect(sbv).toEqual(both.map((c) => c.lines));
  });

  it('ass puts the German text in the Secondary style inside the same Dialogue', () => {
    const out = render(zoo, 'ass', { secondary: de });
    expect(out).toMatch(/^Style: Secondary,Arial,50,/m);
    const dialogues = out.match(/^Dialogue: .*$/gm) ?? [];
    expect(dialogues).toHaveLength(buildCues(zoo.transcript.segments, false).length);
    const withSecond = dialogues.filter((d) => d.includes('\\N{\\rSecondary}'));
    expect(withSecond).toHaveLength(4);
    expect(words(withSecond.map((d) => (d.split('{\\rSecondary}')[1] as string).replace(/\\N/g, ' ')))).toEqual(deWords);
  });

  it('ttml adds a secondary span with its own language', () => {
    const out = render(zoo, 'ttml', { secondary: de });
    expect(xmlProblems(out)).toEqual([]);
    const spans = [...out.matchAll(/<span style="secondary" xml:lang="de">(.*?)<\/span>/g)];
    expect(spans).toHaveLength(4);
    expect(words(spans.map((s) => unescapeXml((s[1] as string).replace(/<br\/>/g, ' '))))).toEqual(deWords);
    expect(out.match(/<p /g)).toHaveLength(buildCues(zoo.transcript.segments, true).length);
  });

  it('csv adds a secondary_text column and text adds an indented line', () => {
    const rows = parseCsv(render(zoo, 'csv', { secondary: de }));
    expect(rows[0]).toEqual(['start', 'end', 'speaker', 'text', 'secondary_text']);
    expect(rows.slice(1).map((r) => r[4])).toEqual([
      'Also hier sind wir vor den Elefanten.',
      '',
      'Das Coole an den Typen ist dass sie sehr, sehr, sehr, lange Rüssel haben.',
      'Und das ist cool.',
      '',
      'Ansonsten gibt es nicht wirklich viel zu sagen.',
    ]);
    const text = render(zoo, 'text', { timestamps: true, secondary: de }).split('\n');
    expect(text.slice(0, 2)).toEqual([
      '[0:01] All right, so here we are, in front of the elephants',
      '       Also hier sind wir vor den Elefanten.',
    ]);
    const untimed = render(zoo, 'text', { secondary: de });
    expect(
      untimed.startsWith('All right, so here we are, in front of the elephants\nAlso hier sind wir vor den Elefanten.\n\n'),
    ).toBe(true);
  });

  it('a translation on the source timings lines up one to one (recorded German G-Wagon translation)', () => {
    const { source, secondary } = gwagonGerman();
    const rows = parseCsv(render(source, 'csv', { secondary }));
    expect(rows.slice(1).map((r) => r[4])).toEqual(secondary.segments.map((s) => csvSafeText(cleanText(s.text))));
    const srt = parseSrt(render(source, 'srt', { secondary }));
    const plain = parseSrt(render(source, 'srt'));
    expect(words(srt.flatMap((c, i) => c.lines.slice(plain[i]?.lines.length)))).toEqual(sourceWords(secondary.segments));
    // Long German text can need more cues than the English alone; every cue keeps the line limits per language.
    for (const c of buildCues(source.transcript.segments, true, { secondary })) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      expect(c.secondary?.length ?? 0).toBeLessThanOrEqual(2);
      for (const l of [...c.lines, ...(c.secondary ?? [])]) expect(l.length).toBeLessThanOrEqual(42);
    }
  });

  it('shifts the secondary transcript with the primary one', () => {
    const shifted = parseSrt(render(zoo, 'srt', { secondary: de, offsetSec: 3 }));
    const base = parseSrt(render(zoo, 'srt', { secondary: de }));
    expect(shifted.map((c) => c.lines)).toEqual(base.map((c) => c.lines));
  });
});

describe('speakers (real diarized Deepgram utterances)', () => {
  const call = nixonCall();
  const segs = call.transcript.segments;
  const turns = segs.filter((s, i) => s.speaker !== segs[i - 1]?.speaker);

  it('the fixture has several speakers and turns', () => {
    expect(new Set(segs.map((s) => s.speaker)).size).toBe(3);
    expect(turns.length).toBeGreaterThan(5);
  });

  it('srt, sbv, ttml and lrc prefix "Speaker N: " at each turn', () => {
    const srt = parseSrt(render(call, 'srt'));
    const labelled = srt.filter((c) => /^Speaker \d: /.test(c.lines[0] ?? ''));
    expect(labelled.map((c) => (c.lines[0] as string).split(':')[0])).toEqual(turns.map((t) => t.speaker));
    const sbv = render(call, 'sbv').match(/^Speaker \d: /gm) ?? [];
    expect(sbv).toHaveLength(turns.length);
    const lrc = render(call, 'lrc').match(/^\[\d{2}:\d{2}\.\d{2}\]Speaker \d: /gm) ?? [];
    expect(lrc).toHaveLength(turns.length);
    const ttml = render(call, 'ttml');
    expect(xmlProblems(ttml)).toEqual([]);
    expect(ttml.match(/<p [^>]*>Speaker \d: /g)).toHaveLength(turns.length);
  });

  it('ass names the speaker of every Dialogue in the Name field', () => {
    const cues = buildCues(segs, false);
    const names = (render(call, 'ass').match(/^Dialogue: .*$/gm) ?? []).map((d) => d.split(',')[4]);
    expect(names).toEqual(cues.map((c) => c.speaker));
  });

  it('text labels turns: per line with timestamps, per paragraph without', () => {
    const timed = render(call, 'text', { timestamps: true }).trimEnd().split('\n');
    expect(timed).toHaveLength(segs.length);
    expect(timed.filter((l) => /^\[\d+:\d\d\] Speaker \d: /.test(l))).toHaveLength(turns.length);
    const paras = render(call, 'text').trimEnd().split('\n\n');
    expect(paras.map((p) => p.split(':')[0])).toEqual(turns.map((t) => t.speaker));
  });

  it('csv fills the speaker column', () => {
    const rows = parseCsv(render(call, 'csv'));
    expect(rows.slice(1).map((r) => r[2])).toEqual(segs.map((s) => s.speaker));
  });

  it('vtt opens each cue with a <v Speaker> voice tag naming its segment speaker', () => {
    const cues = parseVtt(render(call, 'vtt')).cues;
    const built = buildCues(segs, false);
    expect(cues).toHaveLength(built.length);
    expect(cues.map((c) => c.voice)).toEqual(built.map((c) => c.speaker));
    // No "Name: " prefix in VTT: the voice tag carries the speaker.
    expect(cues.some((c) => /^Speaker \d: /.test(c.lines[0] ?? ''))).toBe(false);
  });

  it('markdown and pack start a **Speaker:** paragraph at every turn', () => {
    for (const f of ['markdown', 'pack']) {
      const paras = render(call, f).match(/^\[\d+:\d\d\](?:\([^)]*\))? .*$/gm) ?? [];
      const labels = paras.map((p) => /^\[[^\]]+\](?:\([^)]*\))? \*\*(Speaker \d):\*\* /.exec(p)?.[1]);
      // Every paragraph is labelled, and consecutive paragraphs only repeat a speaker when a long turn was split.
      expect(labels.every(Boolean), f).toBe(true);
      expect(labels.filter((l, i) => l !== labels[i - 1]), f).toEqual(turns.map((t) => t.speaker));
    }
  });
});

describe('formats without speakers or a second language are unchanged by the new options', () => {
  it('srt and vtt are byte-identical with default layout options passed explicitly', () => {
    for (const ctx of Object.values(fixtures)) {
      for (const id of ['srt', 'vtt'])
        expect(render(ctx, id, { maxLineChars: 42, maxLines: 2, offsetSec: 0 })).toBe(render(ctx, id));
    }
  });

  it('cue text never changes with layout, only its grouping (a word longer than a line is cut)', () => {
    for (const opts of [{ maxLineChars: 15 }, { maxLines: 1 }, { maxLineChars: 80, maxLines: 3 }]) {
      expect(cueWords(buildCues(zoo.transcript.segments, false, opts)).join('')).toBe(
        sourceWords(zoo.transcript.segments).join(''),
      );
    }
  });
});
