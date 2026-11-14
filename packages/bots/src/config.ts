/**
 * Bot settings, read from the request's env (process.env on Node, bindings on
 * Workers) on every request. A platform is on only when all of its secrets are
 * set; otherwise its route answers 404.
 */
import type { Env } from '@vid2context/core';

export interface TelegramConfig {
  token: string;
  secret: string;
  /** The bot's own user id: the number before the colon in the token. */
  botId: string;
}

export interface DiscordConfig {
  applicationId: string;
  publicKey: string;
}

export interface SlackConfig {
  signingSecret: string;
  botToken: string;
}

export interface Limits {
  /** Requests per hour, per chat and per user. */
  perHour: number;
  /** Allowlists; an empty set means every chat, guild or team is allowed. */
  telegramChats: Set<string>;
  discordGuilds: Set<string>;
  slackTeams: Set<string>;
}

export const DEFAULT_RATE_LIMIT_PER_HOUR = 10;

const val = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined;

function list(env: Env, name: string): Set<string> {
  return new Set(
    (env[name] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function telegramConfig(env: Env): TelegramConfig | null {
  const token = val(env, 'TELEGRAM_BOT_TOKEN');
  const secret = val(env, 'TELEGRAM_WEBHOOK_SECRET');
  if (!token || !secret) return null;
  return { token, secret, botId: token.split(':')[0] ?? '' };
}

export function discordConfig(env: Env): DiscordConfig | null {
  const applicationId = val(env, 'DISCORD_APPLICATION_ID');
  const publicKey = val(env, 'DISCORD_PUBLIC_KEY');
  if (!applicationId || !publicKey) return null;
  return { applicationId, publicKey };
}

export function slackConfig(env: Env): SlackConfig | null {
  const signingSecret = val(env, 'SLACK_SIGNING_SECRET');
  const botToken = val(env, 'SLACK_BOT_TOKEN');
  if (!signingSecret || !botToken) return null;
  return { signingSecret, botToken };
}

export function limits(env: Env): Limits {
  const raw = Number(val(env, 'BOTS_RATE_LIMIT_PER_HOUR'));
  return {
    perHour: Number.isFinite(raw) && raw >= 0 && val(env, 'BOTS_RATE_LIMIT_PER_HOUR') ? Math.floor(raw) : DEFAULT_RATE_LIMIT_PER_HOUR,
    telegramChats: list(env, 'BOTS_ALLOWED_CHATS'),
    discordGuilds: list(env, 'BOTS_ALLOWED_GUILDS'),
    slackTeams: list(env, 'BOTS_ALLOWED_TEAMS'),
  };
}

/** True when the allowlist is empty (open) or contains the id. */
export function allowed(list: Set<string>, id: string | undefined): boolean {
  if (list.size === 0) return true;
  return id !== undefined && list.has(id);
}
