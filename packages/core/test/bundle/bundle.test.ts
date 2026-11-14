import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBundle, CONTEXT_FALLBACK, FORMAT_FILE_NAMES, type Manifest, TOOL_VERSION } from '../../src/bundle/build.ts';
import { safeFileName, slugify, UniqueNames } from '../../src/bundle/names.ts';
import { collectBytes } from '../../src/bundle/zip.ts';
import { formatters, render, renderMany } from '../../src/format/index.ts';
import { estimateTokens } from '../../src/tokens.ts';
import { gwagon, hasUnzip, sha256, unzipTest, zoo } from './helpers.ts';
import { readZip } from './zip-reader.ts';

const createdAt = new Date('2026-11-14T16:00:00Z');
const dec = new TextDecoder();

/** Bundle file names for the formatters currently in the map (pack is context.md). */
function formatFiles(): string[] {
  return Object.values(formatters)
    .filter((f) => f.id !== 'pack')
    .map((f) => FORMAT_FILE_NAMES[f.id] ?? `${f.id}.${f.extension}`);
}

async function unzipBundle(bundle: Awaited<ReturnType<typeof buildBundle>>) {
  const bytes = await collectBytes(bundle.zip());
  return { bytes, entries: readZip(bytes) };
}

/** Run `fn` with formatter ids removed from the map, restoring them afterwards. */
async function without<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
  const saved = ids.map((id) => [id, formatters[id]] as const);
  for (const id of ids) delete formatters[id];
  try {
    return await fn();
  } finally {
    for (const [id, f] of saved) if (f) formatters[id] = f;
  }
}

describe('names', () => {
  it('slugs real titles with punctuation, cutting at a word boundary within 60 characters', () => {
    expect(slugify(zoo().metadata.title)).toBe('me-at-the-zoo');
    const g = slugify(gwagon().metadata.title);
    expect(g).toBe('best-worst-g-wagon-years-reliability-interiors-engines');
    expect(g.length).toBeLessThanOrEqual(60);
  });

  it('strips separators, "..", control characters and reserved Windows names', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('a\\b\u0000c\u001fd')).toBe('a-b-c-d');
    expect(slugify('CON')).toBe('con-video');
    expect(slugify('Crème Brûlée')).toBe('creme-brulee');
    expect(slugify('日本語のタイトル', 'jNQXAC9IVRw')).toBe('jnqxac9ivrw');
    expect(safeFileName('../x/../../evil.md')).toBe('x.evil.md');
    expect(safeFileName('nul.txt')).toBe('nul-video.txt');
  });

  it('de-duplicates with -2, -3, keeping extensions and the length cap', () => {
    const u = new UniqueNames();
    expect([u.take('a.md'), u.take('a.md'), u.take('a.md')]).toEqual(['a.md', 'a-2.md', 'a-3.md']);
    const long = slugify(gwagon().metadata.title);
    const v = new UniqueNames();
    v.take(long, 60);
    expect(v.take(long, 60).length).toBeLessThanOrEqual(60);
  });
});

describe('buildBundle, one video', () => {
  it('lays out the files exactly and the zip matches them', async () => {
    const b = await buildBundle([zoo()], { createdAt });
    expect(b.root).toBe('me-at-the-zoo');
    expect(b.filename).toBe('me-at-the-zoo.zip');
    const expected = ['README.md', 'context.md', ...formatFiles(), 'metadata.json', 'chapters.md', 'manifest.json'];
    expect(b.files.map((f) => f.path).sort()).toEqual([...expected].sort());

    const { entries } = await unzipBundle(b);
    expect(entries.map((e) => e.path)).toEqual(b.files.map((f) => `me-at-the-zoo/${f.path}`));
    for (const [i, e] of entries.entries()) expect(e.data).toEqual(b.files[i]?.bytes);
  });

  it('writes a manifest with versions, videos and real sha256 hashes', async () => {
    const b = await buildBundle([zoo()], { createdAt });
    const manifestFile = b.files.find((f) => f.path === 'manifest.json');
    const m = JSON.parse(dec.decode(manifestFile?.bytes)) as Manifest;
    expect(m).toEqual(b.manifest);
    expect(m.tool).toBe('vid2context');
    expect(m.createdAt).toBe('2026-11-14T16:00:00.000Z');
    expect(m.contextFormatter).toBe(formatters.pack ? 'pack' : CONTEXT_FALLBACK.find((id) => formatters[id]));
    const ctx = zoo();
    const contextMd = dec.decode(b.files.find((f) => f.path === 'context.md')?.bytes);
    expect(m.videos).toEqual([
      {
        id: 'youtube:jNQXAC9IVRw',
        title: 'Me at the zoo',
        url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        origin: ctx.transcript.origin,
        language: ctx.transcript.language,
        durationSec: 19,
        estimatedTokens: estimateTokens(contextMd),
        folder: '.',
      },
    ]);
    const others = b.files.filter((f) => f.path !== 'manifest.json');
    expect(m.files.map((f) => f.path)).toEqual(others.map((f) => f.path));
    for (const [i, f] of m.files.entries()) {
      expect(f.bytes).toBe(others[i]?.bytes.length);
      expect(f.sha256).toBe(await sha256(others[i]?.bytes ?? new Uint8Array()));
    }
  });

  it('keeps toolVersion equal to the core package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(TOOL_VERSION).toBe(pkg.version);
  });

  it('metadata.json holds VideoMetadata only, and formatter files match render()', async () => {
    const ctx = zoo();
    const b = await buildBundle([ctx], { createdAt });
    const text = (p: string) => dec.decode(b.files.find((f) => f.path === p)?.bytes);
    expect(JSON.parse(text('metadata.json'))).toEqual(ctx.metadata);
    expect(JSON.parse(text('context.json'))).toEqual(ctx);
    expect(text('transcript.txt')).toBe(render(ctx, 'text'));
    if (formatters.srt) expect(text('transcript.srt')).toBe(render(ctx, 'srt', { timestamps: true }));
    expect(text('chapters.md')).toContain('[0:05](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s)');
  });

  it.skipIf(!formatters.pack)('context.md equals the pack formatter output', async () => {
    const ctx = zoo();
    const b = await buildBundle([ctx], { createdAt });
    const opts = { timestamps: true, includeComments: true, includeVisual: true };
    expect(dec.decode(b.files.find((f) => f.path === 'context.md')?.bytes)).toBe(render(ctx, 'pack', opts));
  });

  it('README explains every file and the agent how-tos', async () => {
    const b = await buildBundle([zoo()], { createdAt });
    const readme = dec.decode(b.files[0]?.bytes);
    expect(b.files[0]?.path).toBe('README.md');
    for (const f of b.files) expect(readme).toContain(`\`${f.path}\`: `);
    for (const s of ['Claude Projects', 'ChatGPT Projects', 'custom GPT', 'Claude Code', 'Cursor', '[Title @ m:ss](link)']) {
      expect(readme).toContain(s);
    }
    expect(readme).not.toMatch(/[\u2013\u2014]/);
  });

  it('omits chapters.md for a video without chapters', async () => {
    const b = await buildBundle([gwagon()], { createdAt });
    expect(b.files.some((f) => f.path === 'chapters.md')).toBe(false);
    expect(b.root).toBe('best-worst-g-wagon-years-reliability-interiors-engines');
  });

  it('restricts formats, and rejects unknown ids listing the available ones', async () => {
    const b = await buildBundle([zoo()], { createdAt, formats: ['text'] });
    expect(b.files.map((f) => f.path)).toEqual([
      'README.md',
      'context.md',
      'transcript.txt',
      'metadata.json',
      'chapters.md',
      'manifest.json',
    ]);
    await expect(buildBundle([zoo()], { formats: ['docx'] })).rejects.toMatchObject({
      code: 'bad-request',
      hint: `Available formats: ${Object.keys(formatters).join(', ')}.`,
    });
    await expect(buildBundle([])).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('falls back to markdown, then text, for context.md when pack is missing', async () => {
    const ctx = zoo();
    const viaMarkdown = await without(['pack'], () => buildBundle([ctx], { createdAt }));
    const md = formatters.markdown ? 'markdown' : 'text';
    expect(viaMarkdown.manifest.contextFormatter).toBe(md);
    expect(dec.decode(viaMarkdown.files.find((f) => f.path === 'context.md')?.bytes)).toBe(render(ctx, md, { timestamps: true }));
    const { bytes } = await unzipBundle(viaMarkdown);
    expect(readZip(bytes).length).toBe(viaMarkdown.files.length);

    const viaText = await without(['pack', 'markdown'], () => buildBundle([ctx], { createdAt }));
    expect(viaText.manifest.contextFormatter).toBe('text');
    expect(dec.decode(viaText.files.find((f) => f.path === 'context.md')?.bytes)).toBe(render(ctx, 'text', { timestamps: true }));
  });
});

describe('buildBundle, many videos', () => {
  it('lays out numbered folders with index.md, llms.txt and one README', async () => {
    const b = await buildBundle([zoo(), gwagon()], { createdAt });
    expect(b.root).toBe('vid2context-2-videos');
    const v1 = 'videos/01-me-at-the-zoo';
    const v2 = 'videos/02-best-worst-g-wagon-years-reliability-interiors-engines';
    const expected = [
      'README.md',
      'context.md',
      'index.md',
      'llms.txt',
      ...['context.md', ...formatFiles(), 'metadata.json', 'chapters.md'].map((f) => `${v1}/${f}`),
      ...['context.md', ...formatFiles(), 'metadata.json'].map((f) => `${v2}/${f}`),
      'manifest.json',
    ];
    expect(b.files.map((f) => f.path).sort()).toEqual(expected.sort());
    expect(b.manifest.videos.map((v) => v.folder)).toEqual([v1, v2]);

    const text = (p: string) => dec.decode(b.files.find((f) => f.path === p)?.bytes);
    expect(text('index.md')).toContain(
      `| 2 | Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked! | Alliance Motorworks | 18:04 |`,
    );
    const llms = text('llms.txt').split('\n');
    expect(llms[0]).toBe('# 2 videos');
    expect(llms[2]).toMatch(/^> /);
    expect(llms).toContain(`- [Me at the zoo](${v1}/context.md): context pack (jawed, 0:19, creator-captions)`);
    if (formatters.markdown) expect(text('llms.txt')).toContain(`(${v2}/transcript.md)`);
    expect(text('README.md')).toContain('`videos/`');

    const { bytes, entries } = await unzipBundle(b);
    expect(entries.map((e) => e.path)).toEqual(b.files.map((f) => `vid2context-2-videos/${f.path}`));
    if (hasUnzip) expect(unzipTest(bytes)).toContain('No errors detected');
  });

  it.skipIf(!formatters.pack?.renderMany)('top-level context.md equals renderMany(pack)', async () => {
    const cs = [zoo(), gwagon()];
    const b = await buildBundle(cs, { createdAt, maxTokens: 4000 });
    const opts = { timestamps: true, includeComments: true, includeVisual: true, maxTokens: 4000 };
    expect(dec.decode(b.files.find((f) => f.path === 'context.md')?.bytes)).toBe(renderMany(cs, 'pack', opts));
  });

  it('de-duplicates folders for the same title and honours opts.name', async () => {
    const b = await buildBundle([zoo(), zoo()], { createdAt, name: 'My Zoo / Collection' });
    expect(b.root).toBe('my-zoo-collection');
    expect(b.filename).toBe('my-zoo-collection.zip');
    expect(b.manifest.videos.map((v) => v.folder)).toEqual(['videos/01-me-at-the-zoo', 'videos/02-me-at-the-zoo-2']);
  });

  it('builds a valid multi-video bundle without the pack formatter', async () => {
    const b = await without(['pack'], () => buildBundle([zoo(), gwagon()], { createdAt }));
    expect(b.manifest.contextFormatter).not.toBe('pack');
    const { entries } = await unzipBundle(b);
    const top = dec.decode(entries.find((e) => e.path === 'vid2context-2-videos/context.md')?.data);
    expect(top).toContain('Me at the zoo');
    expect(top).toContain('G-Wagon');
  });

  it('produces byte-identical zips for the same inputs and createdAt', async () => {
    const a = await collectBytes((await buildBundle([zoo(), gwagon()], { createdAt })).zip());
    const b = await collectBytes((await buildBundle([zoo(), gwagon()], { createdAt })).zip());
    expect(a).toEqual(b);
  });
});
