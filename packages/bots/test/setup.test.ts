import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { botUrls, setupDiscord, setupTelegram, slackManifest } from '../src/setup.ts';
import { readFixture } from './util.ts';

const BASE = { BOTS_PUBLIC_BASE_URL: 'https://v2c.example.com' };

describe('webhook URLs', () => {
  it('adds /api/v1 unless the base already has it', () => {
    expect(botUrls(BASE).telegram).toBe('https://v2c.example.com/api/v1/bots/telegram');
    expect(botUrls({ BOTS_PUBLIC_BASE_URL: 'https://v2c.example.com/api/v1/' }).discord).toBe(
      'https://v2c.example.com/api/v1/bots/discord',
    );
    expect(botUrls({ BOTS_PUBLIC_BASE_URL: 'https://example.com/v2c' }).slackEvents).toBe(
      'https://example.com/v2c/api/v1/bots/slack/events',
    );
  });

  it('requires an https base URL', () => {
    expect(() => botUrls({})).toThrow('BOTS_PUBLIC_BASE_URL is not set.');
    expect(() => botUrls({ BOTS_PUBLIC_BASE_URL: 'http://localhost:8787' })).toThrow('must use https');
  });
});

describe('Slack manifest', () => {
  it('points the slash command and events at this server with the scopes the bot uses', () => {
    const m = slackManifest(BASE) as {
      features: { slash_commands: { command: string; url: string; should_escape: boolean }[]; app_home: Record<string, boolean> };
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions: { request_url: string; bot_events: string[] } };
    };
    expect(m.features.slash_commands).toEqual([
      expect.objectContaining({
        command: '/vid2context',
        url: 'https://v2c.example.com/api/v1/bots/slack/commands',
        should_escape: true,
      }),
    ]);
    expect(m.features.app_home.messages_tab_enabled).toBe(true);
    expect(m.settings.event_subscriptions).toEqual({
      request_url: 'https://v2c.example.com/api/v1/bots/slack/events',
      bot_events: ['app_mention', 'message.im'],
    });
    expect(m.oauth_config.scopes.bot).toEqual(['commands', 'chat:write', 'files:write', 'app_mentions:read', 'im:history']);
  });
});

describe('Telegram setup', () => {
  // Real response recorded from api.telegram.org for a token that does not exist.
  const unauthorized = { status: 401, body: readFixture('telegram-401.json') };
  const env = { ...BASE, TELEGRAM_BOT_TOKEN: '123456:invalid-token-for-recording', TELEGRAM_WEBHOOK_SECRET: 'abc_DEF-123' };

  it('sends setWebhook with the URL and secret, and explains a rejected token without printing it', async () => {
    const fetch = replayFetch([{ url: /api\.telegram\.org\/bot.+\/setWebhook$/, response: unauthorized }]);
    const err = await setupTelegram(testContext({ env, fetch })).catch((e: Error & { hint?: string }) => e);
    expect(err).toMatchObject({ code: 'auth', message: 'Telegram setWebhook: Unauthorized' });
    expect((err as { hint?: string }).hint).toContain('@BotFather');
    expect(String((err as Error).message)).not.toContain('invalid-token');
    expect(JSON.parse(String(fetch.calls[0]?.body))).toEqual({
      url: 'https://v2c.example.com/api/v1/bots/telegram',
      secret_token: 'abc_DEF-123',
      allowed_updates: ['message'],
    });
  });

  it('refuses a secret Telegram would reject, before any request', async () => {
    const fetch = replayFetch([]);
    await expect(setupTelegram(testContext({ env: { ...env, TELEGRAM_WEBHOOK_SECRET: 'has spaces' }, fetch }))).rejects.toThrow(
      'characters Telegram does not allow',
    );
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('Discord setup', () => {
  // Real response recorded from discord.com for a bot token that does not exist.
  const unauthorized = { status: 401, body: readFixture('discord-401.json') };
  const env = { ...BASE, DISCORD_APPLICATION_ID: '1234567890123456789', DISCORD_BOT_TOKEN: 'invalid-token-for-recording' };

  it('registers /video with a bot token, globally or in one guild', async () => {
    const fetch = replayFetch([{ method: 'PUT', url: /\/commands$/, response: unauthorized }]);
    await expect(setupDiscord(testContext({ env, fetch }))).rejects.toThrow('HTTP 401');
    await expect(setupDiscord(testContext({ env, fetch }), { guildId: '290926798626357999' })).rejects.toMatchObject({
      code: 'auth',
      hint: expect.stringContaining('DISCORD_BOT_TOKEN was rejected'),
    });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      'https://discord.com/api/v10/applications/1234567890123456789/commands',
      'https://discord.com/api/v10/applications/1234567890123456789/guilds/290926798626357999/commands',
    ]);
    expect(fetch.calls[0]?.headers.authorization).toBe('Bot invalid-token-for-recording');
    expect(JSON.parse(String(fetch.calls[0]?.body))).toEqual([
      {
        name: 'video',
        type: 1,
        description: 'Summarize a video with timestamp links and attach the full transcript',
        options: [{ name: 'url', description: 'Link to the video, for example a YouTube URL', type: 3, required: true }],
      },
    ]);
  });
});
