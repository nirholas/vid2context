/**
 * `buildBundle`: every file an agent could want for one or many videos, laid
 * out as docs/bundle.md describes, plus a streaming zip of them. Formats come
 * from the `formatters` map at runtime, so a formatter added later appears in
 * every bundle without changes here.
 */
import { Vid2ContextError } from '../errors.ts';
import { type FormatOptions, type Formatter, formatters } from '../format/index.ts';
import { estimateTokens } from '../tokens.ts';
import type { VideoContext } from '../types.ts';
import { chaptersMd, commentsMd, indexMd, llmsTxt, readmeMd, type VideoEntry, visualMd } from './files.ts';
import { safeFileName, slugify, UniqueNames } from './names.ts';
import { zipStream } from './zip.ts';

/** Kept equal to packages/core/package.json "version" (a test checks it). */
export const TOOL_VERSION = '0.1.0';

/** Formatter ids whose file names are fixed by the bundle layout. */
export const FORMAT_FILE_NAMES: Record<string, string> = {
  text: 'transcript.txt',
  markdown: 'transcript.md',
  srt: 'transcript.srt',
  vtt: 'transcript.vtt',
  json: 'context.json',
  pack: 'context.md',
};

/** Formatters tried in order for `context.md`. */
export const CONTEXT_FALLBACK = ['pack', 'markdown', 'text'] as const;

/** Options formatters may read. Fields beyond `FormatOptions` are ignored by formatters that do not know them. */
type BundleFormatOptions = FormatOptions & {
  maxTokens?: number;
  includeComments?: boolean;
  includeVisual?: boolean;
  linkTimestamps?: boolean;
};

/** A formatter that may also render several videos into one document. */
type MaybeMany = Formatter & { renderMany?: (contexts: VideoContext[], opts: BundleFormatOptions) => string };

export interface BundleOptions {
  /** Formatter ids to include (default: every formatter in the map). `context.md` is always written. */
  formats?: string[];
  /** Write comments.md and include comments in formats that support them. Default true. */
  comments?: boolean;
  /** Write visual.md and include visual notes in formats that support them. Default true. */
  visual?: boolean;
  /** Token budget for context.md. Default: the pack formatter's own default. */
  maxTokens?: number;
  /** Root folder and zip name. Default: the title slug (one video) or "vid2context-<n>-videos". */
  name?: string;
  /** Timestamp for the manifest and zip entries. Same inputs and `createdAt` give byte-identical zips. */
  createdAt?: Date;
}

export interface BundleFile {
  /** Path relative to the bundle root (the zip adds the root folder). */
  path: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface ManifestVideo {
  id: string;
  title: string;
  url?: string;
  origin: string;
  language: string;
  durationSec?: number;
  estimatedTokens: number;
  folder: string;
}

export interface Manifest {
  tool: 'vid2context';
  toolVersion: string;
  createdAt: string;
  /** Formatter that produced every context.md: 'pack', or a fallback when pack is not available. */
  contextFormatter: string;
  videos: ManifestVideo[];
  files: { path: string; bytes: number; sha256: string }[];
}

export interface Bundle {
  /** Suggested download name, "<root>.zip". */
  filename: string;
  /** Root folder inside the zip. */
  root: string;
  files: BundleFile[];
  manifest: Manifest;
  /** A fresh zip stream on every call. */
  zip(): ReadableStream<Uint8Array>;
}

const MD = 'text/markdown; charset=utf-8';
const JSON_TYPE = 'application/json';
const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function selectFormats(requested: string[] | undefined): Formatter[] {
  const all = Object.values(formatters);
  if (!requested) return all;
  const unknown = requested.filter((id) => !formatters[id]);
  if (unknown.length) {
    throw new Vid2ContextError('bad-request', `Unknown format${unknown.length > 1 ? 's' : ''} "${unknown.join('", "')}".`, {
      hint: `Available formats: ${Object.keys(formatters).join(', ')}.`,
    });
  }
  return all.filter((f) => requested.includes(f.id));
}

/** The formatter context.md comes from: pack, else markdown, else text. */
export function contextFormatter(): MaybeMany {
  for (const id of CONTEXT_FALLBACK) {
    const f = formatters[id];
    if (f) return f;
  }
  throw new Vid2ContextError('bad-request', 'No formatter can produce context.md.', {
    hint: `Register a "pack", "markdown" or "text" formatter. Available: ${Object.keys(formatters).join(', ')}.`,
  });
}

function renderContext(contexts: VideoContext[], opts: BundleFormatOptions): string {
  const f = contextFormatter();
  const o: BundleFormatOptions = { ...opts, timestamps: true };
  if (contexts.length === 1) return f.render(contexts[0] as VideoContext, o);
  if (f.renderMany) return f.renderMany(contexts, o);
  return contexts.map((c) => f.render(c, o).trimEnd()).join('\n\n---\n\n') + '\n';
}

function fileNameFor(f: Formatter): string {
  return FORMAT_FILE_NAMES[f.id] ?? safeFileName(`${f.id}.${f.extension}`);
}

interface VideoFiles {
  entry: VideoEntry;
  files: BundleFile[];
  contextText: string;
}

function videoFiles(context: VideoContext, folder: string, formats: Formatter[], o: BundleOptions): VideoFiles {
  const names = new UniqueNames();
  const files: BundleFile[] = [];
  const prefix = folder === '.' ? '' : `${folder}/`;
  const add = (name: string, text: string, mimeType: string) => {
    const unique = names.take(name);
    files.push({ path: prefix + unique, bytes: encoder.encode(text), mimeType });
  };
  const fmtOpts: BundleFormatOptions = { includeComments: o.comments !== false, includeVisual: o.visual !== false };

  const contextText = renderContext([context], { ...fmtOpts, maxTokens: o.maxTokens });
  add('context.md', contextText, MD);
  for (const f of formats) {
    if (f.id === 'pack') continue; // pack is context.md, written above
    const opts: BundleFormatOptions = { ...fmtOpts, timestamps: f.id !== 'text' };
    add(fileNameFor(f), f.render(context, opts), f.mimeType);
  }
  add('metadata.json', `${JSON.stringify(context.metadata, null, 2)}\n`, JSON_TYPE);
  if (context.metadata.chapters.length) add('chapters.md', chaptersMd(context), MD);
  if (o.comments !== false && context.comments?.length) add('comments.md', commentsMd(context), MD);
  if (o.visual !== false && context.visual?.length) add('visual.md', visualMd(context), MD);

  const fileNames = new Set(files.map((f) => f.path.slice(prefix.length)));
  return { entry: { context, folder, files: fileNames }, files, contextText };
}

function describeFiles(files: BundleFile[], prefix: string, formats: Formatter[]) {
  const byName = new Map(formats.map((f) => [fileNameFor(f), f.description]));
  return files
    .filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/'))
    .map((f) => {
      const name = f.path.slice(prefix.length);
      return { name, description: byName.get(name) };
    });
}

/** Build the bundle for one or many videos. */
export async function buildBundle(contexts: VideoContext[], opts: BundleOptions = {}): Promise<Bundle> {
  if (!contexts.length) {
    throw new Vid2ContextError('bad-request', 'A bundle needs at least one video.', {
      hint: 'Pass one or more VideoContext objects.',
    });
  }
  const formats = selectFormats(opts.formats);
  const createdAt = opts.createdAt ?? new Date();
  const multi = contexts.length > 1;
  const first = contexts[0] as VideoContext;
  const root = opts.name
    ? slugify(opts.name, 'vid2context')
    : multi
      ? `vid2context-${contexts.length}-videos`
      : slugify(first.metadata.title, first.metadata.ref.nativeId);

  const files: BundleFile[] = [];
  const perVideo: VideoFiles[] = [];

  if (!multi) {
    perVideo.push(videoFiles(first, '.', formats, opts));
  } else {
    const width = Math.max(2, String(contexts.length).length);
    const slugs = new UniqueNames();
    contexts.forEach((c, i) => {
      const slug = slugs.take(slugify(c.metadata.title, c.metadata.ref.nativeId), 60);
      const folder = `videos/${String(i + 1).padStart(width, '0')}-${slug}`;
      perVideo.push(videoFiles(c, folder, formats, opts));
    });
  }

  const title = multi ? (opts.name ?? `${contexts.length} videos`) : first.metadata.title;
  const contextFmt = contextFormatter().id;

  if (multi) {
    const entries = perVideo.map((v) => v.entry);
    const fmtOpts: BundleFormatOptions = {
      includeComments: opts.comments !== false,
      includeVisual: opts.visual !== false,
      maxTokens: opts.maxTokens,
    };
    files.push({ path: 'context.md', bytes: encoder.encode(renderContext(contexts, fmtOpts)), mimeType: MD });
    files.push({ path: 'index.md', bytes: encoder.encode(indexMd(title, entries)), mimeType: MD });
    files.push({ path: 'llms.txt', bytes: encoder.encode(llmsTxt(title, entries)), mimeType: 'text/plain; charset=utf-8' });
  }
  for (const v of perVideo) files.push(...v.files);

  const videoPrefix = multi ? `${perVideo[0]?.entry.folder}/` : '';
  const rootFiles = [
    { name: 'README.md' },
    ...describeFiles(files, '', formats).filter((f) => f.name !== 'README.md'),
    { name: 'manifest.json' },
  ];
  const videoFileList = multi ? describeFiles(files, videoPrefix, formats) : [];
  const readme = readmeMd({ title, multi, rootFiles, videoFiles: videoFileList });
  files.unshift({ path: 'README.md', bytes: encoder.encode(readme), mimeType: MD });

  const manifest: Manifest = {
    tool: 'vid2context',
    toolVersion: TOOL_VERSION,
    createdAt: createdAt.toISOString(),
    contextFormatter: contextFmt,
    videos: perVideo.map((v) => {
      const m = v.entry.context.metadata;
      const t = v.entry.context.transcript;
      return {
        id: m.ref.id,
        title: m.title,
        ...(m.ref.url ? { url: m.ref.url } : {}),
        origin: t.origin,
        language: t.language,
        ...(m.durationSec !== undefined ? { durationSec: m.durationSec } : {}),
        estimatedTokens: estimateTokens(v.contextText),
        folder: v.entry.folder,
      };
    }),
    files: await Promise.all(files.map(async (f) => ({ path: f.path, bytes: f.bytes.length, sha256: await sha256Hex(f.bytes) }))),
  };
  files.push({ path: 'manifest.json', bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`), mimeType: JSON_TYPE });

  return {
    filename: `${root}.zip`,
    root,
    files,
    manifest,
    zip: () =>
      zipStream(
        files.map((f) => ({ path: `${root}/${f.path}`, data: f.bytes })),
        { date: createdAt },
      ),
  };
}
