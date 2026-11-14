/**
 * One-time platform setup, used by the scripts in packages/bots/scripts/.
 * Every function reads keys from env, calls the platform through ctx.fetch,
 * and returns lines describing what it did. Keys never appear in the output.
 */
import { type Ctx, type Env, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { DISCORD_API, VIDEO_COMMAND } from './discord.ts';
import { SLACK_COMMAND } from './slack.ts';
import { TELEGRAM_API } from './telegram.ts';

export interface BotUrls {
  telegram: string;
  discord: string;
  slackEvents: string;
  slackCommands: string;
}

function need(env: Env, name: string, hint: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Vid2ContextError('bad-request', `${name} is not set.`, { hint });
  return v;
}

/** Public webhook URLs. BOTS_PUBLIC_BASE_URL is the server's public origin; /api/v1 is added unless it is already there. */
export function botUrls(env: Env): BotUrls {
  const raw = need(
    env,
    'BOTS_PUBLIC_BASE_URL',
    'Set it to the public HTTPS origin of your vid2context server, for example https://v2c.example.com.',
  );
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new Vid2ContextError('bad-request', 'BOTS_PUBLIC_BASE_URL is not a URL.', {
      hint: 'Use a full URL such as https://v2c.example.com.',
    });
  }
  if (base.protocol !== 'https:') {
    throw new Vid2ContextError('bad-request', 'BOTS_PUBLIC_BASE_URL must use https.', {
      hint: 'Telegram, Discord and Slack only deliver to HTTPS URLs. A Cloudflare Tunnel gives a local server one.',
    });
  }
  const path = base.pathname.replace(/\/+$/, '');
  const api = `${base.origin}${path.endsWith('/api/v1') ? path : `${path}/api/v1`}`;
  return {
    telegram: `${api}/bots/telegram`,
    discord: `${api}/bots/discord`,
    slackEvents: `${api}/bots/slack/events`,
    slackCommands: `${api}/bots/slack/commands`,
  };
}

// ---------------------------------------------------------------- Telegram

interface TgResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function tg<T>(ctx: Ctx, token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetchWithTimeout(ctx, `${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TgResult<T>;
  if (!data.ok) {
    throw new Vid2ContextError(
      res.status === 401 ? 'auth' : 'upstream',
      `Telegram ${method}: ${data.description ?? res.status}`,
      {
        status: res.status,
        hint: res.status === 401 ? 'TELEGRAM_BOT_TOKEN was rejected. Copy it again from @BotFather.' : undefined,
      },
    );
  }
  return data.result as T;
}

/** setWebhook with the secret, the bot's command menu, then getWebhookInfo to show the result. */
export async function setupTelegram(ctx: Ctx): Promise<string[]> {
  const token = need(ctx.env, 'TELEGRAM_BOT_TOKEN', 'Create a bot with @BotFather and copy its token.');
  const secret = need(ctx.env, 'TELEGRAM_WEBHOOK_SECRET', 'Generate one, for example with `openssl rand -hex 32`.');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Vid2ContextError('bad-request', 'TELEGRAM_WEBHOOK_SECRET has characters Telegram does not allow.', {
      hint: 'Use 1 to 256 characters from A-Z, a-z, 0-9, _ and -. `openssl rand -hex 32` makes a valid one.',
    });
  }
  const url = botUrls(ctx.env).telegram;
  await tg(ctx, token, 'setWebhook', { url, secret_token: secret, allowed_updates: ['message'] });
  await tg(ctx, token, 'setMyCommands', {
    commands: [
      { command: 'video', description: 'Summarize a video: /video <link>' },
      { command: 'help', description: 'How to use this bot' },
    ],
  });
  const info = await tg<{ url?: string; pending_update_count?: number; last_error_message?: string }>(
    ctx,
    token,
    'getWebhookInfo',
  );
  return [
    `Telegram webhook set to ${info.url ?? url} (updates: message; secret token header enabled).`,
    'Command menu set: /video, /help.',
    `Pending updates: ${info.pending_update_count ?? 0}.`,
    ...(info.last_error_message ? [`Last delivery error reported by Telegram: ${info.last_error_message}`] : []),
  ];
}

// ---------------------------------------------------------------- Discord

/** Register the /video command (globally, or in one guild for instant testing) and optionally set the interactions URL. */
export async function setupDiscord(ctx: Ctx, opts: { guildId?: string; setEndpoint?: boolean } = {}): Promise<string[]> {
  const appId = need(
    ctx.env,
    'DISCORD_APPLICATION_ID',
    'Copy the Application ID from the Developer Portal, General Information.',
  );
  const botToken = need(ctx.env, 'DISCORD_BOT_TOKEN', 'Copy the token from the Developer Portal, Bot, Reset Token.');
  const headers = { authorization: `Bot ${botToken}`, 'content-type': 'application/json' };
  const path = opts.guildId ? `/applications/${appId}/guilds/${opts.guildId}/commands` : `/applications/${appId}/commands`;
  const res = await fetchWithTimeout(ctx, `${DISCORD_API}${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify([VIDEO_COMMAND]),
  });
  if (!res.ok) {
    const err = await errorFromResponse(res, 'Discord register commands');
    throw new Vid2ContextError(err.code, err.message, {
      status: err.status,
      hint: res.status === 401 ? 'DISCORD_BOT_TOKEN was rejected. Reset it in the Developer Portal, Bot.' : err.hint,
    });
  }
  const commands = (await res.json()) as { id: string; name: string }[];
  const lines = [
    `Registered ${opts.guildId ? `in guild ${opts.guildId}` : 'globally'}: ${commands.map((c) => `/${c.name} (id ${c.id})`).join(', ')}.`,
  ];
  const endpoint = ctx.env.BOTS_PUBLIC_BASE_URL ? botUrls(ctx.env).discord : undefined;
  if (opts.setEndpoint) {
    if (!endpoint)
      throw new Vid2ContextError('bad-request', 'BOTS_PUBLIC_BASE_URL is not set.', {
        hint: 'It is needed to set the interactions URL.',
      });
    // Discord sends a signed PING to the URL before accepting it, so the server must be reachable now.
    const patch = await fetchWithTimeout(ctx, `${DISCORD_API}/applications/@me`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ interactions_endpoint_url: endpoint }),
    });
    if (!patch.ok) {
      const err = await errorFromResponse(patch, 'Discord set interactions endpoint');
      throw new Vid2ContextError(err.code, err.message, {
        status: err.status,
        hint: 'Discord PINGs the URL first: start the server with DISCORD_PUBLIC_KEY set and make sure the URL is reachable.',
      });
    }
    lines.push(`Interactions endpoint URL set to ${endpoint}.`);
  } else {
    lines.push(
      endpoint
        ? `Interactions endpoint URL to paste in the Developer Portal (or rerun with --endpoint): ${endpoint}`
        : 'Set BOTS_PUBLIC_BASE_URL to print the interactions endpoint URL.',
    );
  }
  if (!opts.guildId) lines.push('Global commands can take a while to appear in every server; use --guild <id> to test at once.');
  return lines;
}

// ---------------------------------------------------------------- Slack

/** A Slack app manifest (JSON) with this server's URLs: paste it at api.slack.com/apps, Create New App, From a manifest. */
export function slackManifest(env: Env, name = 'vid2context'): Record<string, unknown> {
  const urls = botUrls(env);
  return {
    display_information: {
      name,
      description: 'Summaries with timestamp links and full transcripts for video links.',
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: false },
      slash_commands: [
        {
          command: SLACK_COMMAND,
          url: urls.slackCommands,
          description: 'Summarize a video and attach the transcript',
          usage_hint: '<video link>',
          should_escape: true,
        },
      ],
    },
    oauth_config: {
      scopes: { bot: ['commands', 'chat:write', 'files:write', 'app_mentions:read', 'im:history'] },
    },
    settings: {
      event_subscriptions: { request_url: urls.slackEvents, bot_events: ['app_mention', 'message.im'] },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
