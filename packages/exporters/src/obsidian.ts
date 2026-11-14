/**
 * Obsidian export: the files of a vault folder, one note per video and one
 * index note per collection. Runtime-neutral: this only builds strings. The
 * Node writer in node.ts puts them on disk; the HTTP route returns them as
 * JSON; a bundler can zip them.
 *
 * Conventions (https://help.obsidian.md): YAML frontmatter properties,
 * `[[path|alias]]` wikilinks (the pipe escaped as `\|` inside tables) and
 * `> [!type]` callouts. Every note carries a `vid2context-id` property so a
 * later export can recognise and update its own notes without touching the
 * user's.
 */
import type { Collection, Comment, VideoContext } from '@vid2context/core';
import { formatTimestamp } from '@vid2context/core';
import { type LayoutOptions, layoutTranscript } from './layout.ts';

export interface ObsidianFile {
  /** Vault-relative path with `/` separators, ending in `.md`. */
  path: string;
  content: string;
}

export interface ObsidianOptions {
  /** Collection the videos belong to. Adds an index note and links each note to it. */
  collection?: Collection;
  /** Vault-relative folder for the notes. Default: the collection name, or "vid2context". */
  folder?: string;
  /**
   * Existing briefs or summaries (Markdown), keyed by video id (`youtube:<id>`).
   * A note gets a summary callout only when its video has one here; none is ever generated.
   */
  briefs?: Record<string, string>;
  layout?: LayoutOptions;
}

/** The property that marks a note as written by vid2context, and for which video or collection. */
export const ID_PROPERTY = 'vid2context-id';

const MAX_NAME_BYTES = 180;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

function cleanName(name: string): string {
  let s = name
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[/\\|]/g, '-')
    .replace(/"/g, "'")
    .replace(/[<>*?#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (utf8Length(s) > MAX_NAME_BYTES) {
    const chars = [...s];
    while (chars.length > 0 && utf8Length(chars.join('')) > MAX_NAME_BYTES) chars.pop();
    s = chars.join('').replace(/[.\s-]+$/, '');
  }
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/**
 * A file or folder name Obsidian, Windows, macOS and Linux all accept, kept
 * readable: `:` becomes " - ", slashes and pipes become "-", quotes become
 * apostrophes, and the characters that break links (`# ^ [ ]`) or filesystems
 * (`* ? < >`, control characters) are dropped. Names are capped at 180 UTF-8
 * bytes. An empty result falls back to `fallback` (cleaned the same way), then
 * to "Untitled".
 */
export function safeFileName(name: string, fallback = 'Untitled'): string {
  return cleanName(name) || cleanName(fallback) || 'Untitled';
}

/** A YAML double-quoted scalar. JSON string syntax is valid YAML; the two Unicode line separators are escaped too. */
export function yamlString(s: string): string {
  return JSON.stringify(s)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** An Obsidian tag: no spaces, only letters, digits, `_`, `-` and `/`, and not purely numeric. */
export function safeTag(tag: string): string | undefined {
  const t = tag
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '')
    .replace(/^[-/]+|[-/]+$/g, '');
  if (!t || /^[\d/-]+$/.test(t)) return undefined;
  return t;
}

const URL_RE = /https?:\/\/[^\s<>|]+/g;

function escapePlain(s: string): string {
  return s
    .replace(/[\\`*_[\]<>#$|]/g, (c) => `\\${c}`)
    .replace(/==/g, '\\=\\=')
    .replace(/~~/g, '\\~\\~')
    .replace(/%%/g, '\\%\\%');
}

/**
 * Escape Markdown and Obsidian syntax (emphasis, links, tags, math, highlights,
 * comments, table pipes) in transcript, description and comment text so it
 * renders as typed. Bare URLs are left intact so Obsidian still links them.
 */
export function escapeMarkdown(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    out += escapePlain(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + escapePlain(s.slice(last));
}

/** Text for a wikilink alias: no pipes or brackets, which would end the link. */
function aliasText(s: string): string {
  return s.replace(/\|/g, '-').replace(/\[/g, '(').replace(/\]/g, ')').replace(/\s+/g, ' ').trim();
}

function tableCell(s: string): string {
  return escapeMarkdown(s.replace(/\s+/g, ' ').trim());
}

/** A frontmatter value. `{ date }` is written unquoted (YYYY-MM-DD) so Obsidian shows it as a date property. */
type Property = string | number | boolean | string[] | { date: string } | undefined;

function frontmatter(entries: [string, Property][]): string {
  const lines = ['---'];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const v of value) lines.push(`  - ${yamlString(v)}`);
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${yamlString(value)}`);
    } else if (typeof value === 'object') {
      lines.push(`${key}: ${value.date}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function callout(type: string, title: string, body: string, folded = false): string {
  const head = `> [!${type}]${folded ? '-' : ''} ${title}`;
  const lines = body
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((l) => l.trimEnd())
    .map((l) => (l ? `> ${l}` : '>'));
  return [head, ...lines].join('\n');
}

function datePart(iso: string | undefined): string | undefined {
  const m = iso?.match(/^\d{4}-\d{2}-\d{2}/);
  return m?.[0];
}

function dateProperty(iso: string | undefined): { date: string } | undefined {
  const d = datePart(iso);
  return d ? { date: d } : undefined;
}

function commentLines(c: Comment, depth: number): string[] {
  const flags = [
    c.isCreator ? 'creator' : undefined,
    c.isPinned ? 'pinned' : undefined,
    c.likes !== undefined ? `${c.likes} likes` : undefined,
    datePart(c.publishedAt),
  ].filter(Boolean);
  const indent = '  '.repeat(depth);
  const text = c.text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((l) => escapeMarkdown(l.trim()))
    .filter(Boolean);
  const head = `${indent}- **${escapeMarkdown(c.author)}**${flags.length ? ` (${flags.join(', ')})` : ''}: ${text[0] ?? ''}`;
  const rest = text.slice(1).map((l) => `${indent}  ${l}`);
  return [head, ...rest, ...(c.replies ?? []).flatMap((r) => commentLines(r, depth + 1))];
}

/** Assigns unique names within one folder, comparing case-insensitively (macOS and Windows filesystems). */
class NameAllocator {
  private used = new Set<string>();
  take(name: string): string {
    let candidate = name;
    for (let n = 2; this.used.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}

function linkTarget(path: string): string {
  return path.replace(/\.md$/, '');
}

function videoNote(
  context: VideoContext,
  opts: ObsidianOptions,
  indexLink: { target: string; alias: string } | undefined,
  layout: LayoutOptions | undefined,
): string {
  const m = context.metadata;
  const t = context.transcript;
  const tags = [...new Set(['vid2context', ...(m.tags ?? []).map(safeTag).filter((x): x is string => Boolean(x))])];
  const parts: string[] = [
    frontmatter([
      ['title', m.title],
      ['channel', m.channel?.name],
      ['url', m.ref.url],
      ['published', dateProperty(m.publishedAt)],
      ['duration', m.durationSec !== undefined ? formatTimestamp(m.durationSec) : undefined],
      ['tags', tags],
      ['transcript_origin', t.origin],
      ['language', t.language],
      ['translated', t.translated ? true : undefined],
      ['collection', indexLink ? `[[${indexLink.target}|${indexLink.alias}]]` : undefined],
      [ID_PROPERTY, m.ref.id],
    ]),
    `# ${escapeMarkdown(m.title)}`,
  ];
  const facts = [
    m.ref.url ? `[Open the video](${m.ref.url})` : undefined,
    m.channel
      ? m.channel.url
        ? `[${escapeMarkdown(m.channel.name)}](${m.channel.url})`
        : escapeMarkdown(m.channel.name)
      : undefined,
    m.durationSec !== undefined ? formatTimestamp(m.durationSec) : undefined,
    `${t.origin.replace(/-/g, ' ')} (${t.language}${t.translated ? ', machine-translated' : ''})`,
  ].filter(Boolean);
  parts.push(facts.join(' | '));
  if (indexLink) parts.push(`Part of [[${indexLink.target}|${indexLink.alias}]].`);
  const brief = opts.briefs?.[m.ref.id]?.trim();
  if (brief) parts.push(callout('summary', 'Summary', brief));
  if (m.description?.trim()) parts.push(callout('info', 'Description', escapeMarkdown(m.description), true));
  for (const section of layoutTranscript(context, layout)) {
    parts.push(`## ${escapeMarkdown(section.title)}`);
    for (const p of section.paragraphs) {
      const stamp = p.url ? `[${p.stamp}](${p.url})` : `\\[${p.stamp}\\]`;
      parts.push(`${stamp} ${escapeMarkdown(p.text)}`);
    }
  }
  if (context.comments && context.comments.length > 0) {
    parts.push('## Comments', context.comments.flatMap((c) => commentLines(c, 0)).join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

function indexNote(
  collection: Collection,
  rows: { context: VideoContext; target: string }[],
  missing: string[],
  folderAlias: string,
): string {
  const parts: string[] = [
    frontmatter([
      ['title', collection.name],
      ['tags', ['vid2context', 'vid2context-collection']],
      ['videos', rows.length],
      ['created', dateProperty(collection.createdAt)],
      ['updated', dateProperty(collection.updatedAt)],
      ['sources', collection.sources],
      [ID_PROPERTY, `collection:${collection.id}`],
    ]),
    `# ${escapeMarkdown(collection.name)}`,
  ];
  if (collection.description?.trim()) parts.push(escapeMarkdown(collection.description.trim()));
  if (collection.sources.length > 0) {
    parts.push(
      '## Sources',
      collection.sources.map((s) => (/^https?:\/\//i.test(s) ? `- <${s}>` : `- ${escapeMarkdown(s)}`)).join('\n'),
    );
  }
  const showPublished = rows.some((r) => datePart(r.context.metadata.publishedAt));
  const table = [
    `| # | Video | Channel | Duration |${showPublished ? ' Published |' : ''} Transcript |`,
    `|---|---|---|---|${showPublished ? '---|' : ''}---|`,
    ...rows.map(({ context, target }, i) => {
      const m = context.metadata;
      const cells = [
        String(i + 1),
        `[[${target}\\|${aliasText(m.title)}]]`,
        tableCell(m.channel?.name ?? ''),
        m.durationSec !== undefined ? formatTimestamp(m.durationSec) : '',
        ...(showPublished ? [datePart(m.publishedAt) ?? ''] : []),
        context.transcript.origin,
      ];
      return `| ${cells.join(' | ')} |`;
    }),
  ];
  const total = rows.reduce((sum, r) => sum + (r.context.metadata.durationSec ?? 0), 0);
  parts.push(
    '## Videos',
    table.join('\n'),
    `${rows.length} ${rows.length === 1 ? 'video' : 'videos'}, ${formatTimestamp(total)} in total. Notes are in the ${escapeMarkdown(folderAlias)} folder.`,
  );
  if (missing.length > 0) {
    parts.push(
      '## Not exported',
      'These videos are in the collection but had no saved context to export:',
      missing.map((id) => `- \`${id}\``).join('\n'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

/** One `{ path, content }` per note: a note per video (in collection order when there is one) and the collection's index note. */
export function renderObsidian(contexts: VideoContext[], opts: ObsidianOptions = {}): ObsidianFile[] {
  const collection = opts.collection;
  const folderSegments = (opts.folder ?? (collection ? collection.name : 'vid2context'))
    .split(/[/\\]+/)
    .map(cleanName)
    .filter(Boolean);
  const folder = folderSegments.length > 0 ? folderSegments.join('/') : 'vid2context';
  const seen = new Set<string>();
  let ordered = contexts.filter((c) => {
    if (seen.has(c.metadata.ref.id)) return false;
    seen.add(c.metadata.ref.id);
    return true;
  });
  if (collection) {
    const pos = new Map(collection.videoIds.map((id, i) => [id, i]));
    ordered = [...ordered].sort(
      (a, b) => (pos.get(a.metadata.ref.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.metadata.ref.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  const names = new NameAllocator();
  const indexPath = collection ? `${folder}/${names.take(safeFileName(collection.name, collection.id))}.md` : undefined;
  const indexLink = indexPath && collection ? { target: linkTarget(indexPath), alias: aliasText(collection.name) } : undefined;
  const notes = ordered.map((context) => ({
    context,
    path: `${folder}/${names.take(safeFileName(context.metadata.title, context.metadata.ref.nativeId))}.md`,
  }));
  const files: ObsidianFile[] = notes.map(({ context, path }) => ({
    path,
    content: videoNote(context, opts, indexLink, opts.layout),
  }));
  if (collection && indexPath) {
    const missing = collection.videoIds.filter((id) => !seen.has(id));
    files.push({
      path: indexPath,
      content: indexNote(
        collection,
        notes.map((n) => ({ context: n.context, target: linkTarget(n.path) })),
        missing,
        folder,
      ),
    });
  }
  return files;
}

/** The Goal's entry point: `exportObsidian(contexts, collection?)`. */
export function exportObsidian(
  contexts: VideoContext[],
  collection?: Collection,
  opts: Omit<ObsidianOptions, 'collection'> = {},
): ObsidianFile[] {
  return renderObsidian(contexts, { ...opts, collection });
}

/** Reads the `vid2context-id` property from a note's frontmatter, or undefined when the note has none. */
export function noteId(content: string): string | undefined {
  const fm = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fm?.[1]) return undefined;
  const line = fm[1].match(new RegExp(`^${ID_PROPERTY}:[ \\t]*(.*?)[ \\t]*$`, 'm'));
  const raw = line?.[1];
  if (!raw) return undefined;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}
