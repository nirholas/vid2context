/**
 * The result's files, made in the browser with `buildBundle` from
 * @vid2context/core. Formats come from the `formatters` map at runtime, so a
 * formatter added to core appears here without a change to the app.
 */
import {
  type Bundle,
  type BundleFile,
  buildBundle,
  FORMAT_FILE_NAMES,
  type Formatter,
  formatters,
  type VideoContext,
  zipStream,
} from '@vid2context/core';

export interface ViewFile {
  /** Path inside the bundle ("transcript.srt", "videos/01-x/context.md"). */
  path: string;
  bytes: Uint8Array;
  mimeType: string;
  /** What the file is, for the file list. */
  description: string;
}

/** The order files are listed in. Anything not named here follows, then README.md and manifest.json. */
const ORDER = [
  'context.md',
  'transcript.md',
  'transcript.txt',
  'transcript.srt',
  'transcript.vtt',
  'context.json',
  'metadata.json',
  'chapters.md',
  'comments.md',
  'visual.md',
];
const LAST = ['README.md', 'manifest.json'];

const FIXED: Record<string, string> = {
  'context.md': 'The one file to give an AI: metadata, chapters and the transcript with timestamp links, sized for a model.',
  'metadata.json': 'Title, channel, duration, description, tags and chapters as JSON.',
  'chapters.md': 'Chapters with links to where each one starts.',
  'comments.md': 'Viewer comments as fetched.',
  'visual.md': 'What was on screen (slides, code, charts) with links to each moment.',
  'README.md': 'What each file is, and how to use the folder with Claude, ChatGPT, Claude Code or Cursor.',
  'manifest.json': 'Every file with its size and sha256, plus how each transcript was made.',
  'index.md': 'A table of every video in the bundle.',
  'llms.txt': 'An index of the bundle in the llms.txt format.',
};

/** Formatter whose output a bundle file name holds. */
export function formatterForFile(name: string): Formatter | undefined {
  const byName = Object.entries(FORMAT_FILE_NAMES).find(([, file]) => file === name)?.[0];
  if (byName && formatters[byName]) return formatters[byName];
  return Object.values(formatters).find((f) => `${f.id}.${f.extension}` === name);
}

export function describeFile(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  const f = formatterForFile(name);
  if (name === 'context.md') return FIXED[name] as string;
  if (f) return f.description;
  return FIXED[name] ?? '';
}

function rank(path: string): number {
  const i = ORDER.indexOf(path);
  if (i >= 0) return i;
  const j = LAST.indexOf(path);
  if (j >= 0) return 1000 + j;
  return 500;
}

export function sortFiles<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The bundle writes transcript.txt as plain text. With the timestamps option
 * the app writes it with "[m:ss]" lines instead, and keeps manifest.json and
 * the zip consistent with the new bytes.
 */
async function withTimestampedText(bundle: Bundle, context: VideoContext): Promise<Bundle> {
  const text = formatters.text;
  const i = bundle.files.findIndex((f) => f.path === 'transcript.txt');
  if (!text || i < 0) return bundle;
  const bytes = encoder.encode(text.render(context, { timestamps: true }));
  const manifest = structuredClone(bundle.manifest);
  const entry = manifest.files.find((f) => f.path === 'transcript.txt');
  if (entry) {
    entry.bytes = bytes.length;
    entry.sha256 = await sha256Hex(bytes);
  }
  const files: BundleFile[] = bundle.files.map((f, j) => {
    if (j === i) return { ...f, bytes };
    if (f.path === 'manifest.json') return { ...f, bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) };
    return f;
  });
  const date = new Date(manifest.createdAt);
  return {
    ...bundle,
    files,
    manifest,
    zip: () =>
      zipStream(
        files.map((f) => ({ path: `${bundle.root}/${f.path}`, data: f.bytes })),
        { date },
      ),
  };
}

export interface ResultBundleOptions {
  /** Write transcript.txt with "[m:ss]" lines. */
  timestamps?: boolean;
  createdAt?: Date;
}

export async function resultBundle(contexts: VideoContext[], opts: ResultBundleOptions = {}): Promise<Bundle> {
  const bundle = await buildBundle(contexts, { createdAt: opts.createdAt });
  if (opts.timestamps && contexts.length === 1) return withTimestampedText(bundle, contexts[0] as VideoContext);
  return bundle;
}

export function viewFiles(bundle: Bundle): ViewFile[] {
  return sortFiles(bundle.files).map((f) => ({ ...f, description: describeFile(f.path) }));
}

const decoder = new TextDecoder();

export function fileText(f: { bytes: Uint8Array }): string {
  return decoder.decode(f.bytes);
}
