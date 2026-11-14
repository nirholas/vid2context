/**
 * Rendering a VideoReply in each platform's own markup.
 *
 *   Telegram  HTML parse mode: escape &, < and > (and " inside attributes); 4096 characters per message
 *   Slack     mrkdwn: escape &, < and >; links are <url|text>
 *   Discord   Markdown in an embed description (4096 characters); masked links [text](url);
 *             mentions are disabled through allowed_mentions, Markdown characters escaped
 *
 * Titles, bullets and error text come from videos and models, so all of it is escaped.
 */
import type { ReplyBullet, UserError, VideoReply } from './reply.ts';

export const TELEGRAM_MAX = 4096;
export const DISCORD_EMBED_MAX = 4096;
export const SLACK_TEXT_MAX = 3900;

export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape Discord Markdown so video titles and model text render literally. */
export function escapeDiscord(s: string): string {
  return s.replace(/([\\*_~`|>#[\]()-])/g, '\\$1');
}

function subtitle(r: VideoReply): string {
  return [r.channel, r.duration].filter(Boolean).join(' \u00b7 ');
}

/** Add lines while they fit; the summary is cut at a bullet boundary, never mid-link. */
function fit(lines: string[], fixed: number, max: number): string[] {
  const out: string[] = [];
  let used = fixed;
  for (const line of lines) {
    if (used + line.length + 1 > max) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

function summaryNote(e: UserError): string {
  return `Summary unavailable: ${e.message}${e.hint ? ` ${e.hint}` : ''}`;
}

// ---------------------------------------------------------------- Telegram

function tgBullet(b: ReplyBullet): string {
  const cites = b.citations
    .map((c) => (c.url ? `<a href="${escapeTelegramHtml(c.url)}">[${c.label}]</a>` : `[${c.label}]`))
    .join(' ');
  return `\u2022 ${escapeTelegramHtml(b.text)} ${cites}`;
}

export function telegramMessage(r: VideoReply): string {
  const title = r.url
    ? `<b><a href="${escapeTelegramHtml(r.url)}">${escapeTelegramHtml(r.title)}</a></b>`
    : `<b>${escapeTelegramHtml(r.title)}</b>`;
  const head = [title, subtitle(r) ? escapeTelegramHtml(subtitle(r)) : ''].filter(Boolean);
  const foot = [
    r.summaryError ? `<i>${escapeTelegramHtml(summaryNote(r.summaryError))}</i>` : '',
    `<i>Transcript attached (${escapeTelegramHtml(r.transcript.description)}).</i>`,
  ].filter(Boolean);
  const fixed = head.join('\n').length + foot.join('\n').length + 4;
  const bullets = fit(r.bullets.map(tgBullet), fixed, TELEGRAM_MAX);
  return [head.join('\n'), bullets.join('\n'), foot.join('\n')].filter(Boolean).join('\n\n');
}

export function telegramError(input: string, e: UserError): string {
  const lines = [`Could not summarize ${escapeTelegramHtml(input)}: ${escapeTelegramHtml(e.message)}`];
  if (e.hint) lines.push(`<i>${escapeTelegramHtml(e.hint)}</i>`);
  return lines.join('\n').slice(0, TELEGRAM_MAX);
}

// ---------------------------------------------------------------- Slack

function slackBullet(b: ReplyBullet): string {
  const cites = b.citations.map((c) => (c.url ? `<${c.url}|[${c.label}]>` : `[${c.label}]`)).join(' ');
  return `\u2022 ${escapeSlack(b.text)} ${cites}`;
}

export function slackMessage(r: VideoReply): string {
  const title = r.url ? `*<${r.url}|${escapeSlack(r.title)}>*` : `*${escapeSlack(r.title)}*`;
  const head = [title, subtitle(r) ? escapeSlack(subtitle(r)) : ''].filter(Boolean);
  const foot = [r.summaryError ? `_${escapeSlack(summaryNote(r.summaryError))}_` : ''].filter(Boolean);
  const fixed = head.join('\n').length + foot.join('\n').length + 4;
  const bullets = fit(r.bullets.map(slackBullet), fixed, SLACK_TEXT_MAX);
  return [head.join('\n'), bullets.join('\n'), foot.join('\n')].filter(Boolean).join('\n\n');
}

export function slackError(input: string, e: UserError): string {
  return [`Could not summarize ${escapeSlack(input)}: ${escapeSlack(e.message)}`, e.hint ? `_${escapeSlack(e.hint)}_` : '']
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------- Discord

export interface DiscordEmbed {
  title: string;
  url?: string;
  description: string;
  footer?: { text: string };
}

function discordBullet(b: ReplyBullet): string {
  // <url> inside a masked link keeps Discord from adding a preview for every timestamp.
  const cites = b.citations.map((c) => (c.url ? `[[${c.label}]](<${c.url}>)` : `[${c.label}]`)).join(' ');
  return `- ${escapeDiscord(b.text)} ${cites}`;
}

export function discordEmbed(r: VideoReply): DiscordEmbed {
  const head = subtitle(r) ? escapeDiscord(subtitle(r)) : '';
  const foot = r.summaryError ? `*${escapeDiscord(summaryNote(r.summaryError))}*` : '';
  const bullets = fit(r.bullets.map(discordBullet), head.length + foot.length + 4, DISCORD_EMBED_MAX);
  const description = [head, bullets.join('\n'), foot].filter(Boolean).join('\n\n').slice(0, DISCORD_EMBED_MAX);
  return {
    title: r.title.slice(0, 256),
    ...(r.url ? { url: r.url } : {}),
    description,
    footer: { text: `Transcript attached (${r.transcript.description}).`.slice(0, 2048) },
  };
}

export function discordError(input: string, e: UserError): string {
  return [`Could not summarize ${escapeDiscord(input)}: ${escapeDiscord(e.message)}`, e.hint ? `*${escapeDiscord(e.hint)}*` : '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);
}
