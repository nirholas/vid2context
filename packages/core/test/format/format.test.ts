import { describe, expect, it } from 'vitest';
import { Vid2ContextError } from '../../src/errors.ts';
import { formatters, render, renderMany } from '../../src/format/index.ts';
import { describeOrigin, groupParagraphs } from '../../src/format/paragraphs.ts';
import { formatTimestamp } from '../../src/segments.ts';
import { estimateTokens } from '../../src/tokens.ts';
import type { Segment, VideoContext } from '../../src/types.ts';
import { cueProblems, githubAnchor, loadContext, parseSrt, parseVtt, readRepoFile } from './helpers.ts';

// Real VideoContext output of the pipeline: tests/fixtures/README.md.
const fixtures = { jNQXAC9IVRw: loadContext('jNQXAC9IVRw'), cCPsdFdlshc: loadContext('cCPsdFdlshc') };
const short = fixtures.jNQXAC9IVRw;
const long = fixtures.cCPsdFdlshc;
const snap = (name: string) => `./__snapshots__/${name}`;

describe('text and json are unchanged', () => {
  // The baseline files were written by the foundation formatters before the new formats were added.
  for (const [id, ctx] of Object.entries(fixtures)) {
    it(`${id}: byte-identical to the foundation output`, () => {
      expect(render(ctx, 'text')).toBe(readRepoFile(`packages/core/test/format/__snapshots__/${id}.foundation-text.txt`));
      expect(render(ctx, 'text', { timestamps: true })).toBe(
        readRepoFile(`packages/core/test/format/__snapshots__/${id}.foundation-text-timestamps.txt`),
      );
      expect(render(ctx, 'json')).toBe(readRepoFile(`packages/core/test/format/__snapshots__/${id}.foundation-json.txt`));
    });
  }
});

describe('registry', () => {
  it('registers the shared formatter ids with their extensions', () => {
    const ext = Object.fromEntries(Object.values(formatters).map((f) => [f.id, f.extension]));
    expect(ext).toEqual({
      text: 'txt',
      json: 'json',
      markdown: 'md',
      srt: 'srt',
      vtt: 'vtt',
      pack: 'md',
      ass: 'ass',
      ttml: 'ttml',
      sbv: 'sbv',
      lrc: 'lrc',
      csv: 'csv',
    });
    for (const [key, f] of Object.entries(formatters)) expect(f.id).toBe(key);
  });

  it('renderMany refuses formats that render one video, naming the ones that accept several', () => {
    for (const id of ['text', 'json', 'markdown', 'srt', 'vtt']) {
      try {
        renderMany([short, long], id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(Vid2ContextError);
        expect((err as Vid2ContextError).code).toBe('bad-request');
        expect((err as Vid2ContextError).hint).toContain('pack');
      }
    }
  });

  it('rejects unknown formats', () => {
    expect(() => render(short, 'docx')).toThrow(/Unknown format/);
    expect(() => renderMany([short], 'docx')).toThrow(/Unknown format/);
  });
});

describe('snapshots', () => {
  for (const [id, ctx] of Object.entries(fixtures)) {
    for (const f of ['markdown', 'srt', 'vtt', 'pack']) {
      it(`${id} ${f}`, async () => {
        await expect(render(ctx, f)).toMatchFileSnapshot(snap(`${id}.${f}.${formatters[f]?.extension}`));
      });
    }
  }
});

describe('markdown', () => {
  it('writes the title block, description excerpt and chapter headings', () => {
    const md = render(short, 'markdown');
    expect(md.startsWith('# Me at the zoo\n\n- Channel: [jawed](https://www.youtube.com/channel/')).toBe(true);
    expect(md).toContain('- Transcript: creator captions from youtube-captions');
    expect(md.match(/^## .*$/gm)).toEqual(['## Description', '## Intro (0:00)', '## The cool thing (0:05)']);
    expect(md).toContain('[0:01](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s) All right, so here we are');
  });

  it('bounds the description and says it was shortened', () => {
    const md = render(long, 'markdown');
    const desc = md.split('## Description\n\n')[1]?.split('\n\n## ')[0] ?? '';
    const quoted = desc
      .split('\n')
      .filter((l) => l.startsWith('>'))
      .map((l) => l.replace(/^> ?/, ''))
      .join('\n');
    expect(quoted.length).toBeLessThanOrEqual(600);
    expect(desc).toMatch(/Description shortened to \d+ of 795 characters/);
  });

  it('plain timestamps when linkTimestamps is false', () => {
    const md = render(short, 'markdown', { linkTimestamps: false });
    expect(md).toContain('\n[0:01] All right');
    expect(md).not.toContain('&t=');
  });

  it('groups every segment into paragraphs without splitting or losing text', () => {
    const paras = groupParagraphs(long.transcript.segments);
    expect(paras.map((p) => p.text).join(' ')).toBe(long.transcript.segments.map((s) => s.text.trim()).join(' '));
    for (const p of paras.slice(0, -1)) expect(p.endSec - p.startSec).toBeLessThanOrEqual(95);
    const md = render(long, 'markdown');
    expect(md.match(/^\[\d+:\d\d\]\(/gm)?.length).toBe(paras.length);
  });
});

describe('srt and vtt', () => {
  for (const [id, ctx] of Object.entries(fixtures)) {
    it(`${id}: srt parses back and keeps every rule`, () => {
      const cues = parseSrt(render(ctx, 'srt'));
      expect(cueProblems(cues, ctx.transcript.segments)).toEqual([]);
      expect(cues[0]?.startMs).toBe(Math.round((ctx.transcript.segments[0]?.startSec ?? 0) * 1000));
    });

    it(`${id}: vtt parses back and keeps every rule`, () => {
      const { notes, cues } = parseVtt(render(ctx, 'vtt'));
      expect(cueProblems(cues, ctx.transcript.segments)).toEqual([]);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(`Source: ${ctx.metadata.ref.url}`);
      expect(notes[0]).toContain(`Transcript: ${describeOrigin(ctx.transcript)}`);
    });
  }

  it('srt and vtt carry the same timings', () => {
    const a = parseSrt(render(long, 'srt'));
    const b = parseVtt(render(long, 'vtt')).cues;
    expect(b.map((c) => [c.startMs, c.endMs])).toEqual(a.map((c) => [c.startMs, c.endMs]));
  });

  it('escapes & and < in vtt cue text (the long video title has "&")', () => {
    const vtt = render(long, 'vtt');
    expect(vtt).toContain('Best & Worst G-Wagon Years');
    const withAmp: VideoContext = {
      ...long,
      transcript: { ...long.transcript, segments: [{ startSec: 0, endSec: 2, text: long.metadata.title }] },
    };
    expect(render(withAmp, 'vtt')).toContain('Best &amp; Worst');
  });
});

describe('pack', () => {
  const full = render(long, 'pack');
  const paras = groupParagraphs(long.transcript.segments);

  it('unlimited: no truncation marker, all paragraphs present', () => {
    expect(full).not.toContain('omitted for length');
    expect(full.match(/^\[\d+:\d\d\]/gm)?.length).toBe(paras.length);
    expect(full).toContain('cite it as [Title @ m:ss](link)');
  });

  for (const maxTokens of [1000, 4000]) {
    it(`fits ${maxTokens} tokens and marks exactly what was cut`, async () => {
      expect(estimateTokens(full)).toBeGreaterThan(maxTokens);
      const out = render(long, 'pack', { maxTokens });
      await expect(out).toMatchFileSnapshot(snap(`cCPsdFdlshc.pack-${maxTokens}.md`));
      expect(estimateTokens(out)).toBeLessThanOrEqual(maxTokens);
      const kept = out.match(/^\[(\d+:\d\d)\]/gm) ?? [];
      expect(kept.length).toBeLessThan(paras.length);
      // The kept paragraphs are the first ones, in order.
      expect(kept).toEqual(paras.slice(0, kept.length).map((p) => `[${formatTimestamp(p.startSec)}]`));
      const marker = /The rest, (\S+) to (\S+), is omitted for length\. Fetch it with the get_section tool/.exec(out);
      expect(marker?.[1]).toBe(formatTimestamp(paras[kept.length]?.startSec ?? -1));
      expect(marker?.[2]).toBe(formatTimestamp(paras.at(-1)?.endSec ?? -1));
      expect(out).toContain(`Some content was left out to fit a budget of ${maxTokens} tokens.`);
    });
  }

  it('fewer timestamp links before cutting transcript text', () => {
    const out = render(long, 'pack', { maxTokens: 4000 });
    const linked = out.match(/^\[\d+:\d\d\]\(/gm)?.length ?? 0;
    const all = out.match(/^\[\d+:\d\d\]/gm)?.length ?? 0;
    expect(linked).toBe(Math.ceil(all / 3));
  });

  it('refuses a budget too small for the headers, with a hint', () => {
    try {
      render(long, 'pack', { maxTokens: 50 });
      expect.unreachable();
    } catch (err) {
      expect((err as Vid2ContextError).code).toBe('bad-request');
      expect((err as Vid2ContextError).hint).toMatch(/Raise maxTokens to at least \d+/);
    }
  });

  it('render(ctx, pack) is the one-video case of renderMany', () => {
    expect(render(short, 'pack')).toBe(renderMany([short], 'pack'));
  });

  it('renderMany: table of contents with resolving anchors, videos in input order', async () => {
    const out = renderMany([short, long], 'pack');
    await expect(out).toMatchFileSnapshot(snap('many.pack.md'));
    expect(out).toContain('of 2 videos (18:23 in total)');
    const headings = out.match(/^## .*$/gm) ?? [];
    expect(headings).toEqual([
      '## Contents',
      '## Video 1: Me at the zoo',
      '## Video 2: Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!',
    ]);
    const anchors = new Set(headings.map((h) => githubAnchor(h.slice(3))));
    const links = [...out.matchAll(/^\d+\. \[.*\]\(#([^)]+)\)/gm)].map((m) => m[1]);
    expect(links).toHaveLength(2);
    for (const l of links) expect(anchors.has(l as string)).toBe(true);
  });

  it('renderMany with a budget cuts each transcript in proportion and stays within it', () => {
    const out = renderMany([short, long], 'pack', { maxTokens: 2000 });
    expect(estimateTokens(out)).toBeLessThanOrEqual(2000);
    // The short video's single kept paragraph block survives; the long one is cut with a marker.
    expect(out.match(/omitted for length\. Fetch it/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe('edge cases from real data', () => {
  it('last segment ending after durationSec keeps its real end time', () => {
    const last = long.transcript.segments.at(-1) as Segment;
    expect(last.endSec).toBeGreaterThan(long.metadata.durationSec ?? 0);
    expect(parseSrt(render(long, 'srt')).at(-1)?.endMs).toBe(Math.round(last.endSec * 1000));
    expect(render(long, 'markdown').trimEnd().endsWith("and I'll see you next time")).toBe(true);
  });

  it('decodes double-encoded entities from a real srv1 caption payload', () => {
    // Raw <text> bodies of the srv1 track, still entity-encoded twice (and that&amp;#39;s cool).
    const xml = readRepoFile('providers/youtube/test/fixtures/timedtext-jNQXAC9IVRw-en.srv1.xml');
    const segments = [...xml.matchAll(/<text start="([\d.]+)" dur="([\d.]+)">([\s\S]*?)<\/text>/g)].map((m) => ({
      startSec: Number(m[1]),
      endSec: Number(m[1]) + Number(m[2]),
      text: m[3] as string,
    }));
    expect(segments.some((s) => s.text.includes('&amp;#39;'))).toBe(true);
    const ctx: VideoContext = { ...short, transcript: { ...short.transcript, segments } };
    for (const f of ['markdown', 'srt', 'vtt', 'pack']) {
      const out = render(ctx, f);
      expect(out).toContain("and that's cool");
      expect(out).not.toMatch(/&#39;|&amp;#/);
    }
    expect(cueProblems(parseSrt(render(ctx, 'srt')), segments)).toEqual([]);
  });

  it('no chapters and no channel URL', () => {
    // The real long-video context with the channel URL removed.
    const ctx: VideoContext = { ...long, metadata: { ...long.metadata, channel: { name: 'Alliance Motorworks' } } };
    const md = render(ctx, 'markdown');
    expect(md).toContain('\n- Channel: Alliance Motorworks\n');
    expect(md.match(/^## .*$/gm)).toEqual(['## Description', '## Transcript']);
    expect(render(ctx, 'pack')).not.toContain('### Chapters');
  });
});
