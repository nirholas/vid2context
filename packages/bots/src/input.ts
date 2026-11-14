/**
 * Turning chat text into one video input, and refusing anything that is not
 * an online video. Bots are reachable by strangers, so local paths and file
 * URLs are refused before the registry ever sees them (resolving a path would
 * stat the server's filesystem), and refused again if a source still resolves
 * them to the `file` platform.
 */
import { type Registry, Vid2ContextError, type VideoRef } from '@vid2context/core';

const URL_RE = /https?:\/\/[^\s<>"'|]+/gi;
const TRAILING = /[)\].,!?;:]+$/;

function cleanUrl(u: string): string {
  let out = u.replace(TRAILING, '');
  // Keep a closing parenthesis that belongs to the URL, as in Wikipedia links.
  const opens = (out.match(/\(/g) ?? []).length;
  const closes = (out.match(/\)/g) ?? []).length;
  if (opens > closes && u.slice(out.length).startsWith(')')) out += ')';
  return out;
}

/** Every http(s) URL in free text, in order, without duplicates. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0]);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * URLs in Slack message text. Slack sends links as <https://...> or
 * <https://...|label>, and user or channel mentions as <@U123> or <#C123|name>.
 */
export function extractSlackUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<([^<>]+)>/g)) {
    const target = (m[1] ?? '').split('|')[0] ?? '';
    if (/^https?:\/\//i.test(target) && !out.includes(target)) out.push(target);
  }
  for (const url of extractUrls(text.replace(/<[^<>]+>/g, ' '))) if (!out.includes(url)) out.push(url);
  return out;
}

/** Slack escapes &, < and > in message text; undo it for a URL. */
export function unescapeSlack(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** A command argument as typed: trimmed, without surrounding <> (Slack and Discord both allow them). */
export function commandArg(text: string): string {
  const t = text.trim();
  const slack = t.match(/^<([^<>|]+)(\|[^<>]*)?>$/);
  if (slack?.[1]) return unescapeSlack(slack[1]);
  return t.replace(/^<(.+)>$/, '$1').trim();
}

/** Inputs that point at the local filesystem: absolute, relative or home paths, file: URLs, Windows drives, UNC paths. */
export function looksLocal(input: string): boolean {
  const s = input.trim();
  return /^(file:|[/~.\\]|[a-z]:[\\/])/i.test(s);
}

export const LOCAL_REFUSED_HINT = 'Send a link to an online video, for example a YouTube URL. Local files are not accepted here.';

function refuseLocal(): Vid2ContextError {
  return new Vid2ContextError('unsupported-input', 'Only links to online videos are accepted.', { hint: LOCAL_REFUSED_HINT });
}

/** Resolve one input to a single online video, or throw a user-facing error. */
export function resolveVideo(registry: Registry, input: string): VideoRef {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Vid2ContextError('bad-request', 'No video link given.', { hint: 'Add a video URL, for example a YouTube link.' });
  }
  if (looksLocal(trimmed)) throw refuseLocal();
  let ref: VideoRef;
  try {
    ref = registry.resolve(trimmed).ref;
  } catch (err) {
    // The registry's own hint mentions local paths, which a bot never accepts.
    if (err instanceof Vid2ContextError && err.code === 'unsupported-input') {
      throw new Vid2ContextError('unsupported-input', `No installed source understands "${trimmed.slice(0, 120)}".`, {
        hint: 'Send a link to a single video on YouTube or another supported site.',
      });
    }
    throw err;
  }
  if (ref.platform === 'file' || ref.url?.toLowerCase().startsWith('file:')) throw refuseLocal();
  if (ref.kind !== 'video') {
    throw new Vid2ContextError('unsupported-input', `That link is a ${ref.kind}, not a single video.`, {
      hint: 'Send the link of one video.',
    });
  }
  return ref;
}

/** The first candidate that resolves to an online video; the first error when none does. */
export function pickVideo(registry: Registry, candidates: string[]): { ref: VideoRef; input: string } {
  let first: unknown;
  for (const input of candidates) {
    try {
      return { ref: resolveVideo(registry, input), input };
    } catch (err) {
      first ??= err;
    }
  }
  throw first ?? new Vid2ContextError('bad-request', 'No video link found.', { hint: 'Send a video URL, for example a YouTube link.' });
}
