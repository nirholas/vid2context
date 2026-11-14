/**
 * Telegram: webhook updates in, Bot API calls out.
 *
 * Private chats: any message with a link. Groups: `/video <link>` (Telegram
 * delivers commands even in privacy mode) or a reply to one of the bot's own
 * messages. Quick answers (help, refusals, the "typing" indicator) ride on
 * the webhook response itself, which the Bot API allows for one method per
 * update; the summary and the transcript file are sent afterwards.
 *
 * Bot API reference: https://core.telegram.org/bots/api
 */
import { type Ctx, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import type { TelegramConfig } from './config.ts';
import { commandArg, extractUrls } from './input.ts';

export const TELEGRAM_API = 'https://api.telegram.org';

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  chat: { id: number; type?: string };
  from?: { id: number; is_bot?: boolean };
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: { from?: { id: number } };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export const TELEGRAM_HELP = [
  '<b>vid2context</b> turns a video into a short summary with timestamp links, plus the full transcript as a file.',
  '',
  'Send me a video link, for example a YouTube URL. In groups, use <code>/video &lt;link&gt;</code> or reply to one of my messages.',
].join('\n');

export type TelegramPlan =
  | { kind: 'ignore' }
  | { kind: 'help'; message: TgMessage }
  | { kind: 'video'; message: TgMessage; candidates: string[] };

/** URLs the user sent: Telegram's own url and text_link entities first, then a text scan. */
export function telegramUrls(text: string, entities: TgEntity[] = []): string[] {
  const out: string[] = [];
  for (const e of entities) {
    const url = e.type === 'text_link' ? e.url : e.type === 'url' ? text.slice(e.offset, e.offset + e.length) : undefined;
    if (url && !out.includes(url)) out.push(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  }
  for (const url of extractUrls(text)) if (!out.includes(url)) out.push(url);
  return out;
}

/** Decide what an update asks for, without side effects. */
export function planTelegram(update: TgUpdate, cfg: TelegramConfig): TelegramPlan {
  const message = update.message;
  if (!message || message.from?.is_bot) return { kind: 'ignore' };
  const text = message.text ?? message.caption ?? '';
  const entities = message.text !== undefined ? message.entities : message.caption_entities;
  const isPrivate = message.chat.type === undefined || message.chat.type === 'private';
  const command = text.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (command) {
    const name = (command[1] ?? '').toLowerCase();
    const arg = (command[2] ?? '').trim();
    if (name === 'start' || name === 'help') return { kind: 'help', message };
    if (name === 'video') {
      if (!arg) return { kind: 'help', message };
      const urls = telegramUrls(text, entities);
      return { kind: 'video', message, candidates: urls.length > 0 ? urls : [commandArg(arg.split(/\s+/)[0] ?? '')] };
    }
    return isPrivate ? { kind: 'help', message } : { kind: 'ignore' };
  }
  const repliesToBot = message.reply_to_message?.from?.id !== undefined && String(message.reply_to_message.from.id) === cfg.botId;
  if (!isPrivate && !repliesToBot) return { kind: 'ignore' };
  const urls = telegramUrls(text, entities);
  if (urls.length === 0) return isPrivate ? { kind: 'help', message } : { kind: 'ignore' };
  return { kind: 'video', message, candidates: urls };
}

/** Where a reply to `message` goes: the same chat, the same forum topic, as a reply. */
export function replyTarget(message: TgMessage): Record<string, unknown> {
  return {
    chat_id: message.chat.id,
    ...(message.is_topic_message && message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  };
}

/** A Bot API call to return as the webhook response body (no result is reported back). */
export function webhookReply(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { method, ...params };
}

interface TgResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Call the Bot API. The token is part of the URL, so neither the URL nor the token ever appears in errors or logs. */
export async function telegramCall(ctx: Ctx, cfg: TelegramConfig, method: string, body: Record<string, unknown> | FormData) {
  const init: RequestInit =
    body instanceof FormData
      ? { method: 'POST', body }
      : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const res = await fetchWithTimeout(ctx, `${TELEGRAM_API}/bot${cfg.token}/${method}`, init, 60_000);
  let data: TgResponse;
  try {
    data = (await res.json()) as TgResponse;
  } catch {
    data = { ok: false, description: `HTTP ${res.status}` };
  }
  if (!res.ok || !data.ok) {
    const code = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate-limited' : 'upstream';
    throw new Vid2ContextError(code, `Telegram ${method}: ${data.description ?? `HTTP ${res.status}`}`, {
      status: res.status,
      retryAfterSec: data.parameters?.retry_after,
      hint:
        code === 'auth'
          ? 'Check TELEGRAM_BOT_TOKEN (BotFather shows it), and that the bot was not blocked by the user.'
          : 'See the Telegram error above.',
    });
  }
  return data;
}

export function sendMessage(ctx: Ctx, cfg: TelegramConfig, message: TgMessage, html: string) {
  return telegramCall(ctx, cfg, 'sendMessage', {
    ...replyTarget(message),
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export function sendDocument(
  ctx: Ctx,
  cfg: TelegramConfig,
  message: TgMessage,
  file: { filename: string; text: string },
  caption: string,
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(replyTarget(message))) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  form.set('caption', caption.slice(0, 1024));
  form.set('document', new Blob([file.text], { type: 'text/plain; charset=utf-8' }), file.filename);
  return telegramCall(ctx, cfg, 'sendDocument', form);
}
