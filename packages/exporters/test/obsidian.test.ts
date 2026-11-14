import { readFileSync } from 'node:fs';
import { type Collection, type Comment, MemoryStorage, segmentsToText, timestampUrl, type VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { escapeMarkdown, exportObsidian, noteId, renderObsidian, safeFileName, safeTag, yamlString } from '../src/obsidian.ts';

const fixture = (name: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${name}.json`, import.meta.url), 'utf8')) as VideoContext;

const zoo = fixture('youtube-jNQXAC9IVRw');
const gwagon = fixture('youtube-cCPsdFdlshc');
/** Real comments recorded for the same video (test/fixtures/README.md), attached the way the pipeline attaches them. */
const comments = JSON.parse(
  readFileSync(new URL('./fixtures/youtube-jNQXAC9IVRw.comments.json', import.meta.url), 'utf8'),
) as Comment[];
const withComments: VideoContext = { ...zoo, comments };

function split(content: string): { props: Record<string, unknown>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m?.[1] || m[2] === undefined) throw new Error('note has no frontmatter');
  return { props: parse(m[1]) as Record<string, unknown>, body: m[2] };
}

async function collectionOf(name: string, contexts: VideoContext[], extra: { description?: string; sources?: string[] } = {}) {
  const storage = new MemoryStorage();
  const c = await storage.createCollection({ name, ...extra });
  return storage.addToCollection(
    c.id,
    contexts.map((x) => x.metadata.ref.id),
  );
}

describe('renderObsidian', () => {
  it('writes one note per video with valid YAML properties', () => {
    const files = renderObsidian([zoo, gwagon]);
    expect(files.map((f) => f.path)).toEqual([
      'vid2context/Me at the zoo.md',
      'vid2context/Best & Worst G-Wagon Years - Reliability, Interiors & Engines Ranked!.md',
    ]);
    const { props } = split(files[1]?.content ?? '');
    expect(props).toEqual({
      title: 'Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!',
      channel: 'Alliance Motorworks',
      url: 'https://www.youtube.com/watch?v=cCPsdFdlshc',
      duration: '18:04',
      tags: ['vid2context', 'gwagon', 'gwagen', 'mercedes-g', 'g-class'],
      transcript_origin: 'auto-captions',
      language: 'en',
      'vid2context-id': 'youtube:cCPsdFdlshc',
    });
    const zooProps = split(files[0]?.content ?? '').props;
    expect(zooProps.transcript_origin).toBe('creator-captions');
    expect(zooProps.tags).toEqual(['vid2context', 'me-at-the-zoo', 'jawed-karim', 'first-youtube-video']);
    expect(zooProps).not.toHaveProperty('published');
  });

  it('turns chapters into ## headings and starts every paragraph with a working timestamp link', () => {
    const [note] = renderObsidian([zoo]);
    const { body } = split(note?.content ?? '');
    expect(body.match(/^## .+$/gm)).toEqual(['## Intro', '## The cool thing', '## End']);
    const links = [...body.matchAll(/^\[(\d+:\d{2})\]\((https:\/\/www\.youtube\.com\/watch\?v=jNQXAC9IVRw&t=(\d+)s)\) /gm)];
    expect(links.map((l) => l[1])).toEqual(['0:01', '0:05']);
    for (const l of links) expect(l[2]).toBe(timestampUrl(zoo.metadata.ref, Number(l[3])));
    expect(body).toContain('All right, so here we are, in front of the elephants');
    expect(body).toContain('really really long trunks');
  });

  it('keeps every transcript word, in order, across the paragraphs of a long video', () => {
    const [note] = renderObsidian([gwagon]);
    const { body } = split(note?.content ?? '');
    expect(body.match(/^## .+$/gm)).toEqual(['## Transcript']);
    const paragraphs = body.split('\n\n').filter((p) => /^\[\d+:\d{2}\]\(https:/.test(p));
    expect(paragraphs.length).toBeGreaterThan(15);
    const words = (s: string) => s.replace(/\\/g, '').split(/\s+/).filter(Boolean);
    const rendered = paragraphs.flatMap((p) => words(p.replace(/^\[\d+:\d{2}\]\([^)]+\) /, '')));
    expect(rendered).toEqual(words(segmentsToText(gwagon.transcript.segments)));
    const seconds = paragraphs.map((p) => Number(p.match(/&t=(\d+)s\)/)?.[1]));
    expect(seconds).toEqual([...seconds].sort((a, b) => a - b));
  });

  it('adds a summary callout only when a brief exists for the video', () => {
    const plain = renderObsidian([zoo, gwagon]);
    for (const f of plain) expect(f.content).not.toContain('[!summary]');
    const brief = segmentsToText(zoo.transcript.segments);
    const withBrief = renderObsidian([zoo, gwagon], { briefs: { [zoo.metadata.ref.id]: brief } });
    expect(withBrief[0]?.content).toContain(`> [!summary] Summary\n> ${brief}`);
    expect(withBrief[1]?.content).not.toContain('[!summary]');
  });

  it('folds the description into a callout and escapes tags and markup in it', () => {
    const { body } = split(renderObsidian([gwagon])[0]?.content ?? '');
    expect(body).toContain('> [!info]- Description');
    expect(body).toContain('> \\#gwagen  \\#gwagon');
    expect(body).toContain('https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b');
    expect(body).not.toMatch(/ +\n/);
  });

  it('leaves the comments section out when there are no comments', () => {
    for (const f of renderObsidian([zoo, gwagon])) expect(f.content).not.toContain('## Comments');
  });

  it('ends with a Comments section, flags and replies nested under their comment, when comments exist', () => {
    const { body } = split(renderObsidian([withComments])[0]?.content ?? '');
    const section = body.slice(body.indexOf('## Comments\n\n'));
    expect(section).not.toBe(body);
    expect(body.lastIndexOf('\n## ')).toBe(body.indexOf('\n## Comments'));
    const lines = section.split('\n').slice(2).filter(Boolean);
    const [first, second] = comments;
    expect(lines).toEqual([
      "- **@SanDiegoZoo** (pinned, 4800000 likes, 2020-11-15): We're so honored that the first ever YouTube video was filmed here!",
      ...(first?.replies ?? []).map((r) => `  - **${r.author}** (${r.likes} likes, ${r.publishedAt}): ${r.text}`),
      `- **${second?.author}** (${second?.likes} likes, ${second?.publishedAt}): ${second?.text}`,
      ...(second?.replies ?? []).map((r) => `  - **${r.author}** (${r.likes} likes, ${r.publishedAt}): ${r.text}`),
    ]);
  });

  it('writes a collection index note whose wikilinks resolve to the notes, in collection order', async () => {
    const collection = await collectionOf('G-Wagon buyer research', [gwagon, zoo], {
      description: 'Which G-Wagon to buy, from the Alliance Motorworks series.',
      sources: ['https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b'],
    });
    const files = exportObsidian([zoo, gwagon], collection);
    const index = files.find((f) => noteId(f.content) === `collection:${collection.id}`);
    expect(index?.path).toBe('G-Wagon buyer research/G-Wagon buyer research.md');
    const { props, body } = split(index?.content ?? '');
    expect(props.title).toBe('G-Wagon buyer research');
    expect(props.videos).toBe(2);
    expect(props.sources).toEqual(collection.sources);
    expect(body).toContain('Which G-Wagon to buy, from the Alliance Motorworks series.');
    expect(body).toContain('- <https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b>');
    const rows = body.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('| Alliance Motorworks | 18:04 | auto-captions |');
    expect(rows[1]).toContain('| jawed | 0:19 | creator-captions |');
    const paths = new Set(files.map((f) => f.path));
    const targets = [...body.matchAll(/\[\[([^\]\\|]+)\\\|([^\]]+)\]\]/g)].map((m) => m[1]);
    expect(targets).toHaveLength(2);
    for (const t of targets) expect(paths.has(`${t}.md`)).toBe(true);
    expect(body).toContain('2 videos, 18:23 in total.');
    for (const note of files.filter((f) => f !== index)) {
      const p = split(note.content).props;
      expect(p.collection).toBe('[[G-Wagon buyer research/G-Wagon buyer research|G-Wagon buyer research]]');
      expect(note.content).toContain('Part of [[G-Wagon buyer research/G-Wagon buyer research|G-Wagon buyer research]].');
    }
  });

  it('lists collection videos that had no context to export', async () => {
    const collection = await collectionOf('G-Wagon buyer research', [gwagon, zoo]);
    const files = exportObsidian([gwagon], collection);
    const index = files.at(-1)?.content ?? '';
    expect(index).toContain('## Not exported');
    expect(index).toContain('- `youtube:jNQXAC9IVRw`');
  });

  it('dedupes names that collide, case-insensitively', async () => {
    const collection: Collection = await collectionOf('ME AT THE ZOO', [zoo]);
    const files = exportObsidian([zoo, zoo], collection);
    expect(files.map((f) => f.path)).toEqual(['ME AT THE ZOO/Me at the zoo (2).md', 'ME AT THE ZOO/ME AT THE ZOO.md']);
    expect(files[1]?.content).toContain('[[ME AT THE ZOO/Me at the zoo (2)\\|Me at the zoo]]');
  });

  it('puts notes in a chosen folder and drops unsafe folder segments', () => {
    expect(renderObsidian([zoo], { folder: 'Research/../Videos: 2026' })[0]?.path).toBe(
      'Research/Videos - 2026/Me at the zoo.md',
    );
  });
});

describe('helpers', () => {
  it('makes file names Obsidian and every filesystem accept', () => {
    expect(safeFileName(gwagon.metadata.title)).toBe('Best & Worst G-Wagon Years - Reliability, Interiors & Engines Ranked!');
    expect(safeFileName('What is "AC/DC"? #1 [Live] a|b ^x <y> *z*')).toBe("What is 'AC-DC' 1 Live a-b x y z");
    expect(safeFileName('...hidden. ')).toBe('hidden');
    expect(safeFileName('CON')).toBe('CON_');
    expect(safeFileName('???', 'jNQXAC9IVRw')).toBe('jNQXAC9IVRw');
    expect(safeFileName('line\nbreak\ttab')).toBe('line break tab');
    const long = safeFileName('ö'.repeat(300));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(180);
  });

  it('makes tags valid', () => {
    expect(safeTag('mercedes g')).toBe('mercedes-g');
    expect(safeTag('2018')).toBeUndefined();
    expect(safeTag('#G-Class!')).toBe('g-class');
  });

  it('writes YAML strings that parse back to the same text', () => {
    for (const s of [gwagon.metadata.title, 'a: b # c', 'it\'s "quoted"', 'line\u2028sep', '18:04', 'yes', '2026-11-14']) {
      expect(parse(`k: ${yamlString(s)}`)).toEqual({ k: s });
    }
  });

  it('escapes Markdown and Obsidian syntax but leaves URLs alone', () => {
    expect(escapeMarkdown('$50k vs $60k, ==hi== [[x]] #tag %%c%% a|b https://x.test/a_b#c')).toBe(
      '\\$50k vs \\$60k, \\=\\=hi\\=\\= \\[\\[x\\]\\] \\#tag \\%\\%c\\%\\% a\\|b https://x.test/a_b#c',
    );
  });

  it('reads the vid2context-id property back from any quoting style', () => {
    expect(noteId(renderObsidian([zoo])[0]?.content ?? '')).toBe('youtube:jNQXAC9IVRw');
    expect(noteId("---\nvid2context-id: 'youtube:x'\n---\n")).toBe('youtube:x');
    expect(noteId('---\nvid2context-id: youtube:x\n---\n')).toBe('youtube:x');
    expect(noteId('# no frontmatter\nvid2context-id: youtube:x\n')).toBeUndefined();
  });
});
