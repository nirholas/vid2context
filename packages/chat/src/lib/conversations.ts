/**
 * Conversation helpers: sidebar date groups, titles, search and Markdown
 * export with citations as timestamp links.
 */
import { formatTimestamp } from '@vid2context/core';
import { citationsToLinks, citedNumbers, sourceByNumber } from './citations.ts';
import { modelLabel } from './models.ts';
import type { Conversation, MessageRecord } from './types.ts';

export type DateGroup = 'Pinned' | 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

export const DATE_GROUPS: DateGroup[] = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older'];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dateGroup(updatedAt: number, now: number): Exclude<DateGroup, 'Pinned'> {
  const today = startOfDay(now);
  const day = 86_400_000;
  if (updatedAt >= today) return 'Today';
  if (updatedAt >= today - day) return 'Yesterday';
  if (updatedAt >= today - 7 * day) return 'Previous 7 days';
  return 'Older';
}

export function groupConversations(list: Conversation[], now: number): { group: DateGroup; items: Conversation[] }[] {
  const buckets = new Map<DateGroup, Conversation[]>();
  for (const c of [...list].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const g: DateGroup = c.pinned ? 'Pinned' : dateGroup(c.updatedAt, now);
    const arr = buckets.get(g) ?? [];
    arr.push(c);
    buckets.set(g, arr);
  }
  return DATE_GROUPS.filter((g) => buckets.has(g)).map((g) => ({ group: g, items: buckets.get(g) ?? [] }));
}

export function searchConversations(list: Conversation[], query: string): Conversation[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      (c.preview ?? '').toLowerCase().includes(q) ||
      c.contexts.some((x) => x.title.toLowerCase().includes(q)),
  );
}

export const NEW_CHAT_TITLE = 'New chat';

/** A title from the first question: first line, at most 60 characters, cut at a word. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return NEW_CHAT_TITLE;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** The conversation as Markdown: [n] markers become timestamp links, and each answer lists its sources. */
export function conversationToMarkdown(conv: Conversation, messages: MessageRecord[]): string {
  const out: string[] = [`# ${conv.title}`, ''];
  const videos = conv.contexts.filter((c) => c.status === 'ready');
  if (videos.length > 0) {
    out.push('Context:', '');
    for (const v of videos) out.push(`- ${v.title}${v.input && /^https?:/.test(v.input) ? ` (${v.input})` : ''}`);
    out.push('');
  }
  for (const m of messages) {
    if (m.role === 'user') {
      out.push('## You', '', m.content.trim(), '');
      continue;
    }
    const who = m.model ? `Assistant (${modelLabel(m.model, m.rung ?? '')})` : 'Assistant';
    out.push(`## ${who}`, '');
    if (m.status === 'error' && m.error) {
      out.push(`Error (${m.error.code}): ${m.error.message}`, '');
      continue;
    }
    out.push(citationsToLinks(m.content.trim(), m.sources), '');
    const cited = citedNumbers(m.content)
      .map((n) => sourceByNumber(m.sources, n))
      .filter((s) => s !== undefined);
    if (cited.length > 0) {
      out.push('Sources:', '');
      for (const s of cited) {
        const label = `${s.title} @ ${formatTimestamp(s.startSec)}-${formatTimestamp(s.endSec)}`;
        out.push(`${s.n}. ${s.url ? `[${label}](${s.url})` : label}`);
      }
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** A file name for the export: lowercase words joined by hyphens. */
export function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'chat'}.md`;
}

export function newId(): string {
  return crypto.randomUUID();
}
