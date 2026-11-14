/**
 * Markdown for a brief: title, question, sections by topic (consensus first,
 * then disagreements with both sides cited, then single-source claims), a
 * sources table and the appendix of claims that could not be verified.
 * Titles and quotes come from third parties, so they are escaped.
 */
import { formatTimestamp } from '@vid2context/core';
import type { Template } from './templates/index.ts';
import { topicKey } from './text.ts';
import type { Brief, Citation, Point, UnverifiedClaim } from './types.ts';

/** Escape text for a Markdown link label or table cell. */
export function escapeMd(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/([\\[\]|*_`<>])/g, '\\$1')
    .trim();
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 3).trimEnd()}...`;
}

/** `[Title @ m:ss](url) "quote"`; the citation rule shared with agent-side briefs. */
export function citeMd(c: Citation, withQuote = true): string {
  const label = `${escapeMd(c.title)} @ ${formatTimestamp(c.startSec)}`;
  const link = c.url ? `[${label}](${c.url})` : label;
  return withQuote && c.quote ? `${link}: "${escapeMd(clip(c.quote, 160))}"` : link;
}

function cites(list: Citation[]): string {
  return list.map((c) => `  - ${citeMd(c)}`).join('\n');
}

function pointMd(p: Point): string {
  const statement = escapeMd(p.statement);
  if (p.kind === 'disagreement') {
    return [
      `- **Disputed:** ${statement}`,
      `  - For (${p.support.length}):`,
      ...p.support.map((c) => `    - ${citeMd(c)}`),
      `  - Against: ${escapeMd(p.counter ?? '')}`,
      ...p.oppose.map((c) => `    - ${citeMd(c)}`),
    ].join('\n');
  }
  const tag = p.kind === 'consensus' ? `**Agreed by ${p.videos.length} videos:** ` : '';
  return `- ${tag}${statement}\n${cites(p.support)}`;
}

const KIND_ORDER: Record<Point['kind'], number> = { consensus: 0, disagreement: 1, 'single-source': 2 };

/** Topics in the template's preferred order, then by how much agreement and evidence they carry. */
function orderTopics(points: Point[], template: Template): [string, Point[]][] {
  const groups = new Map<string, Point[]>();
  for (const p of points) groups.set(p.topic, [...(groups.get(p.topic) ?? []), p]);
  const preferred = template.topics.map(topicKey);
  const rank = (topic: string) => {
    const i = preferred.indexOf(topicKey(topic));
    return i === -1 ? preferred.length : i;
  };
  const weight = (ps: Point[]) =>
    ps.reduce((n, p) => n + (p.kind === 'consensus' ? 100 : p.kind === 'disagreement' ? 50 : 0) + p.support.length, 0);
  return [...groups.entries()]
    .map(([t, ps]) => [t, ps.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])] as [string, Point[]])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || weight(b[1]) - weight(a[1]));
}

function unverifiedRow(u: UnverifiedClaim): string {
  const where = u.startSec !== undefined ? ` @ ${formatTimestamp(u.startSec)}` : '';
  return `| ${escapeMd(clip(u.claim, 160))} | ${escapeMd(u.videoId ?? '?')}${where} | ${u.reason}: ${escapeMd(u.detail)} |`;
}

export function renderBrief(brief: Brief, template: Template, points: Point[]): string {
  const subject = brief.question ?? (brief.sources.length === 1 ? brief.sources[0]?.title : `${brief.sources.length} videos`);
  const out: string[] = [`# ${template.title}: ${escapeMd(subject ?? '')}`, ''];
  if (brief.question) out.push(`**Question:** ${escapeMd(brief.question)}`, '');
  out.push(
    `Built from ${brief.sources.length} video${brief.sources.length === 1 ? '' : 's'} on ${brief.createdAt.slice(0, 10)}. ` +
      `${brief.claims.length} claims passed citation checks (quote found in the transcript within 30 s of its timestamp); ` +
      `${brief.unverified.length} did not and are listed at the end, uncited. ` +
      `${brief.consensus.length} points have consensus, ${brief.disagreements.length} are disputed, ${brief.singleSource.length} rest on one video.`,
    '',
  );
  if (points.length === 0) out.push('No verified claims. See the appendix for what the model proposed and why it failed.', '');
  for (const [topic, ps] of orderTopics(points, template)) {
    out.push(`## ${escapeMd(topic.charAt(0).toUpperCase() + topic.slice(1))}`, '');
    for (const p of ps) out.push(pointMd(p));
    out.push('');
  }
  out.push('## Sources', '', '| # | Video | Channel | Length | Transcript |', '|---|---|---|---|---|');
  brief.sources.forEach((s, i) => {
    const title = s.url ? `[${escapeMd(s.title)}](${s.url})` : escapeMd(s.title);
    const len = s.durationSec ? formatTimestamp(s.durationSec) : '';
    out.push(`| V${i + 1} | ${title} | ${escapeMd(s.channel ?? '')} | ${len} | ${s.origin}, ${s.language} |`);
  });
  out.push('');
  if (brief.unverified.length > 0) {
    out.push(
      '## Appendix: unverified claims',
      '',
      'The model proposed these, but their quotes could not be matched to the transcript near the timestamp given. They are not cited above.',
      '',
      '| Claim | Video | Reason |',
      '|---|---|---|',
      ...brief.unverified.map(unverifiedRow),
      '',
    );
  }
  if (brief.notes.length > 0) out.push('## Notes', '', ...brief.notes.map((n) => `- ${escapeMd(n)}`), '');
  const rungs = [...new Set(brief.rungs.map((r) => `${r.step}: ${r.rung}`))];
  if (rungs.length > 0) out.push(`_Models: ${rungs.map(escapeMd).join('; ')}._`, '');
  return out.join('\n');
}
