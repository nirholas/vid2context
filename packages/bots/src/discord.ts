/**
 * Discord: interactions in (the `/video url:<link>` slash command), webhook
 * edits out. Discord wants an answer within 3 seconds, so the route answers
 * DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (type 5, the user sees "thinking"),
 * then edits that original response through the interaction webhook once the
 * summary is ready. Interaction tokens last 15 minutes.
 *
 * Reference: https://discord.com/developers/docs/interactions/receiving-and-responding
 */
import { type Ctx, errorFromResponse, fetchWithTimeout } from '@vid2context/core';
import type { DiscordConfig } from './config.ts';
import type { DiscordEmbed } from './format.ts';

export const DISCORD_API = 'https://discord.com/api/v10';

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
export const ResponseType = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5 } as const;
/** Message flag: only the invoking user sees the message. */
export const EPHEMERAL = 1 << 6;

export const COMMAND_NAME = 'video';

/** The slash command, as registered by scripts/discord-register-commands.ts. */
export const VIDEO_COMMAND = {
  name: COMMAND_NAME,
  type: 1,
  description: 'Summarize a video with timestamp links and attach the full transcript',
  options: [{ name: 'url', description: 'Link to the video, for example a YouTube URL', type: 3, required: true }],
};

export interface Interaction {
  id: string;
  type: number;
  token: string;
  application_id?: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: { name?: string; options?: { name: string; type: number; value?: unknown }[] };
}

export function interactionUser(i: Interaction): string | undefined {
  return i.member?.user?.id ?? i.user?.id;
}

export function commandUrl(i: Interaction): string {
  const opt = i.data?.options?.find((o) => o.name === 'url');
  return typeof opt?.value === 'string' ? opt.value : '';
}

/** An immediate reply that only the invoking user sees. */
export function ephemeral(content: string) {
  return {
    type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: content.slice(0, 2000), flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  };
}

function originalUrl(cfg: DiscordConfig, token: string): string {
  return `${DISCORD_API}/webhooks/${cfg.applicationId}/${encodeURIComponent(token)}/messages/@original`;
}

async function check(res: Response, label: string): Promise<void> {
  if (!res.ok) throw await errorFromResponse(res, label);
}

/** Replace the deferred "thinking" message with the summary embed and the transcript file. */
export async function editOriginalWithFile(
  ctx: Ctx,
  cfg: DiscordConfig,
  token: string,
  embed: DiscordEmbed,
  file: { filename: string; text: string; description: string },
): Promise<void> {
  const form = new FormData();
  form.set(
    'payload_json',
    JSON.stringify({
      content: '',
      embeds: [embed],
      attachments: [{ id: 0, filename: file.filename, description: `Transcript (${file.description})`.slice(0, 1024) }],
      allowed_mentions: { parse: [] },
    }),
  );
  form.set('files[0]', new Blob([file.text], { type: 'text/plain; charset=utf-8' }), file.filename);
  const res = await fetchWithTimeout(ctx, originalUrl(cfg, token), { method: 'PATCH', body: form }, 60_000);
  await check(res, 'Discord edit original response');
}

/** Replace the deferred message with plain text (used for errors). */
export async function editOriginalText(ctx: Ctx, cfg: DiscordConfig, token: string, content: string): Promise<void> {
  const res = await fetchWithTimeout(
    ctx,
    originalUrl(cfg, token),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000), embeds: [], allowed_mentions: { parse: [] } }),
    },
    30_000,
  );
  await check(res, 'Discord edit original response');
}
