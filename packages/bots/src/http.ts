/**
 * Webhook routes for the chat bots, as a Hono sub-app. The server mounts it
 * under /api/v1 (`app.route('/api/v1', botsRoutes(deps))`):
 *
 *   POST /bots/telegram         Telegram updates   (X-Telegram-Bot-Api-Secret-Token)
 *   POST /bots/discord          Discord interactions (Ed25519 signature)
 *   POST /bots/slack/events     Slack Events API   (v0 signing secret)
 *   POST /bots/slack/commands   Slack slash command (v0 signing secret)
 *
 * Each request is verified on its raw body before anything is parsed, and
 * gets 401 with no detail when verification fails. A platform whose secrets
 * are not set answers 404, so an unconfigured bot is simply not there.
 */
import type { ChainOptions, Ctx, Registry, Storage } from '@vid2context/core';
import { Hono } from 'hono';
import { Background, backgroundCtx, type WaitUntil } from './background.ts';
import { allowed, discordConfig, limits, slackConfig, telegramConfig } from './config.ts';
import {
  COMMAND_NAME,
  commandUrl,
  editOriginalText,
  editOriginalWithFile,
  ephemeral,
  type Interaction,
  InteractionType,
  interactionUser,
  ResponseType,
} from './discord.ts';
import { discordEmbed, discordError, slackError, slackMessage, telegramError, telegramMessage } from './format.ts';
import { admit } from './gate.ts';
import { commandArg, extractSlackUrls } from './input.ts';
import { RateLimiter, SeenIds } from './ratelimit.ts';
import { buildReply, describeError, type VideoReply } from './reply.ts';
import {
  postMessage,
  respond,
  SLACK_HELP,
  SlackApiError,
  type SlackEnvelope,
  uploadText,
  wantedEvent,
} from './slack.ts';
import { planTelegram, replyTarget, sendDocument, sendMessage, TELEGRAM_HELP, type TgUpdate, webhookReply } from './telegram.ts';
import { verifyDiscord, verifySlack, verifyTelegram } from './verify.ts';

export interface BotsDeps {
  registry: Registry;
  /** Build a Ctx for one request (env, fetch, logger). Bot secrets and limits are read from `ctx.env`. */
  makeCtx: (req: Request) => Ctx;
  /** Keep background work alive after the response (Workers: `executionCtx.waitUntil`). Default: the request's execution context when there is one, else a tracked promise. */
  waitUntil?: WaitUntil;
  /** Optional cache: a video already in storage is answered without fetching it again. */
  storage?: (ctx: Ctx) => Promise<Storage | null>;
  /** LLM chain options for the summary. */
  chain?: ChainOptions;
  /** Clock in milliseconds, for Slack's timestamp check and rate limits. Default Date.now. */
  now?: () => number;
}

export type BotsApp = Hono & {
  /** Resolves once all background work started so far has settled (tests, graceful shutdown). */
  idle(): Promise<void>;
};

/** Background deadlines: Discord tokens expire after 15 minutes, so its work stops just before. */
const DISCORD_DEADLINE_MS = 14 * 60 * 1000;
const DEFAULT_DEADLINE_MS = 20 * 60 * 1000;

export function botsRoutes(deps: BotsDeps): BotsApp {
  const app = new Hono();
  const bg = new Background(deps.waitUntil);
  const limiter = new RateLimiter();
  const seen = new SeenIds();
  const now = deps.now ?? Date.now;

  const reply = async (ctx: Ctx, input: string): Promise<VideoReply> =>
    buildReply(deps.registry, input, ctx, { chain: deps.chain, storage: deps.storage ? await deps.storage(ctx) : null });

  /** The execution context's waitUntil on Workers; undefined on Node, where c.executionCtx throws. */
  const requestWaitUntil = (c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): WaitUntil | undefined => {
    try {
      const ec = c.executionCtx;
      return (p) => ec.waitUntil(p);
    } catch {
      return undefined;
    }
  };

  // ---------------------------------------------------------------- Telegram

  app.post('/bots/telegram', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const cfg = telegramConfig(ctx.env);
    if (!cfg) return c.notFound();
    if (!verifyTelegram(cfg.secret, c.req.header('x-telegram-bot-api-secret-token'))) return c.body(null, 401);
    let update: TgUpdate;
    try {
      update = JSON.parse(await c.req.text()) as TgUpdate;
    } catch {
      return c.body(null, 400);
    }
    if (typeof update.update_id === 'number' && seen.seen(`tg:${update.update_id}`)) return c.body(null, 200);
    const plan = planTelegram(update, cfg);
    if (plan.kind === 'ignore') return c.body(null, 200);
    const target = replyTarget(plan.message);
    if (plan.kind === 'help') {
      return c.json(webhookReply('sendMessage', { ...target, text: TELEGRAM_HELP, parse_mode: 'HTML' }));
    }
    const lim = limits(ctx.env);
    const chatId = String(plan.message.chat.id);
    const userId = String(plan.message.from?.id ?? chatId);
    const gate = admit({
      registry: deps.registry,
      limiter,
      perHour: lim.perHour,
      allowed: allowed(lim.telegramChats, chatId),
      scope: 'chat',
      candidates: plan.candidates,
      rateKeys: [`tg:chat:${chatId}`, `tg:user:${userId}`],
      now: now(),
    });
    if (!gate.ok) {
      return c.json(
        webhookReply('sendMessage', {
          ...target,
          text: telegramError(plan.candidates[0] ?? 'that', gate.error),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
      );
    }
    const job = backgroundCtx(ctx, DEFAULT_DEADLINE_MS);
    const message = plan.message;
    bg.run(
      job,
      'telegram reply',
      async () => {
        const r = await reply(job, gate.input);
        await sendMessage(job, cfg, message, telegramMessage(r));
        await sendDocument(job, cfg, message, r.transcript, `Transcript: ${r.title}`);
        job.log.info('bots: telegram reply sent', { video: r.ref.id, bullets: r.bullets.length, rung: r.rung });
      },
      async (err) => {
        await sendMessage(job, cfg, message, telegramError(gate.input, describeError(err)));
      },
      requestWaitUntil(c),
    );
    // Shows "typing..." while the summary is prepared.
    return c.json(webhookReply('sendChatAction', { chat_id: message.chat.id, action: 'typing' }));
  });

  // ---------------------------------------------------------------- Discord

  app.post('/bots/discord', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const cfg = discordConfig(ctx.env);
    if (!cfg) return c.notFound();
    const body = await c.req.text();
    const ok = await verifyDiscord(
      cfg.publicKey,
      c.req.header('x-signature-ed25519'),
      c.req.header('x-signature-timestamp'),
      body,
    );
    if (!ok) return c.body(null, 401);
    let interaction: Interaction;
    try {
      interaction = JSON.parse(body) as Interaction;
    } catch {
      return c.body(null, 400);
    }
    if (interaction.type === InteractionType.PING) return c.json({ type: ResponseType.PONG });
    if (interaction.type !== InteractionType.APPLICATION_COMMAND || interaction.data?.name !== COMMAND_NAME) {
      return c.json(ephemeral('This command is not handled by vid2context. Use /video with a link.'));
    }
    const input = commandArg(commandUrl(interaction));
    const lim = limits(ctx.env);
    const userId = interactionUser(interaction) ?? 'unknown';
    const gate = admit({
      registry: deps.registry,
      limiter,
      perHour: lim.perHour,
      allowed: allowed(lim.discordGuilds, interaction.guild_id),
      scope: 'server',
      candidates: [input],
      rateKeys: [`dc:channel:${interaction.channel_id ?? interaction.guild_id ?? userId}`, `dc:user:${userId}`],
      now: now(),
    });
    if (!gate.ok) return c.json(ephemeral(discordError(input || 'that', gate.error)));
    const job = backgroundCtx(ctx, DISCORD_DEADLINE_MS);
    const token = interaction.token;
    bg.run(
      job,
      'discord reply',
      async () => {
        const r = await reply(job, gate.input);
        await editOriginalWithFile(job, cfg, token, discordEmbed(r), r.transcript);
        job.log.info('bots: discord reply sent', { video: r.ref.id, bullets: r.bullets.length, rung: r.rung });
      },
      async (err) => {
        await editOriginalText(job, cfg, token, discordError(gate.input, describeError(err)));
      },
      requestWaitUntil(c),
    );
    return c.json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
  });

  // ---------------------------------------------------------------- Slack

  /** Verify a Slack request; returns the raw body, or null when it must be rejected. */
  const slackBody = async (
    c: { req: { text(): Promise<string>; header(name: string): string | undefined } },
    secret: string,
  ): Promise<string | null> => {
    const body = await c.req.text();
    const ok = await verifySlack(
      secret,
      c.req.header('x-slack-signature'),
      c.req.header('x-slack-request-timestamp'),
      body,
      Math.floor(now() / 1000),
    );
    return ok ? body : null;
  };

  app.post('/bots/slack/commands', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const cfg = slackConfig(ctx.env);
    if (!cfg) return c.notFound();
    const body = await slackBody(c, cfg.signingSecret);
    if (body === null) return c.body(null, 401);
    const form = new URLSearchParams(body);
    if (form.get('ssl_check') === '1') return c.body(null, 200);
    const input = commandArg(form.get('text') ?? '');
    if (!input || input.toLowerCase() === 'help') return c.json({ response_type: 'ephemeral', text: SLACK_HELP });
    const team = form.get('team_id') ?? '';
    const channel = form.get('channel_id') ?? '';
    const user = form.get('user_id') ?? '';
    const responseUrl = form.get('response_url') ?? '';
    const lim = limits(ctx.env);
    const gate = admit({
      registry: deps.registry,
      limiter,
      perHour: lim.perHour,
      allowed: allowed(lim.slackTeams, team),
      scope: 'workspace',
      candidates: [input],
      rateKeys: [`sl:${team}:channel:${channel}`, `sl:${team}:user:${user}`],
      now: now(),
    });
    if (!gate.ok) return c.json({ response_type: 'ephemeral', text: slackError(input, gate.error) });
    const job = backgroundCtx(ctx, DEFAULT_DEADLINE_MS);
    bg.run(
      job,
      'slack command reply',
      async () => {
        const r = await reply(job, gate.input);
        const text = slackMessage(r);
        let posted: { channel: string; ts: string };
        try {
          posted = await postMessage(job, cfg, { channel, text });
        } catch (err) {
          // The app is not in this channel (or it is a DM between people): answer through
          // response_url, which needs no membership but cannot carry a file.
          if (err instanceof SlackApiError && ['not_in_channel', 'channel_not_found'].includes(err.slackError) && responseUrl) {
            await respond(job, responseUrl, {
              inChannel: true,
              text: `${text}\n\n_Invite the app to this channel (/invite @vid2context) to also get the transcript file._`,
            });
            job.log.info('bots: slack reply sent through response_url', { video: r.ref.id });
            return;
          }
          throw err;
        }
        await uploadText(
          job,
          cfg,
          { filename: r.transcript.filename, text: r.transcript.text, title: `Transcript: ${r.title}` },
          { channel: posted.channel, threadTs: posted.ts, comment: `Full transcript (${r.transcript.description}).` },
        );
        job.log.info('bots: slack reply sent', { video: r.ref.id, bullets: r.bullets.length, rung: r.rung });
      },
      async (err) => {
        if (responseUrl) await respond(job, responseUrl, { text: slackError(gate.input, describeError(err)) });
        else await postMessage(job, cfg, { channel, text: slackError(gate.input, describeError(err)) });
      },
      requestWaitUntil(c),
    );
    return c.json({
      response_type: 'ephemeral',
      text: `Working on ${gate.input}. The summary and transcript will be posted here shortly.`,
    });
  });

  app.post('/bots/slack/events', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const cfg = slackConfig(ctx.env);
    if (!cfg) return c.notFound();
    const body = await slackBody(c, cfg.signingSecret);
    if (body === null) return c.body(null, 401);
    let envelope: SlackEnvelope;
    try {
      envelope = JSON.parse(body) as SlackEnvelope;
    } catch {
      return c.body(null, 400);
    }
    if (envelope.type === 'url_verification') return c.text(envelope.challenge ?? '');
    if (envelope.type !== 'event_callback') return c.body(null, 200);
    if (envelope.event_id && seen.seen(`sl:${envelope.event_id}`)) return c.body(null, 200);
    const event = envelope.event;
    if (!wantedEvent(event)) return c.body(null, 200);
    const channel = event.channel;
    // Mentions in channels are answered in a thread; direct messages at the top level.
    const threadTs = event.type === 'app_mention' ? (event.thread_ts ?? event.ts) : event.thread_ts;
    const job = backgroundCtx(ctx, DEFAULT_DEADLINE_MS);
    const say = (text: string) => postMessage(job, cfg, { channel, text, threadTs });
    const urls = extractSlackUrls(event.text ?? '');
    const team = envelope.team_id ?? '';
    const lim = limits(ctx.env);
    const gate =
      urls.length === 0
        ? null
        : admit({
            registry: deps.registry,
            limiter,
            perHour: lim.perHour,
            allowed: allowed(lim.slackTeams, team),
            scope: 'workspace',
            candidates: urls,
            rateKeys: [`sl:${team}:channel:${channel}`, `sl:${team}:user:${event.user}`],
            now: now(),
          });
    bg.run(
      job,
      'slack event reply',
      async () => {
        if (!gate) return void (await say(SLACK_HELP));
        if (!gate.ok) return void (await say(slackError(urls[0] ?? 'that', gate.error)));
        const r = await reply(job, gate.input);
        const posted = await say(slackMessage(r));
        await uploadText(
          job,
          cfg,
          { filename: r.transcript.filename, text: r.transcript.text, title: `Transcript: ${r.title}` },
          { channel: posted.channel, threadTs: threadTs ?? posted.ts, comment: `Full transcript (${r.transcript.description}).` },
        );
        job.log.info('bots: slack reply sent', { video: r.ref.id, bullets: r.bullets.length, rung: r.rung });
      },
      async (err) => {
        await say(slackError(gate?.ok ? gate.input : (urls[0] ?? 'that'), describeError(err)));
      },
      requestWaitUntil(c),
    );
    return c.body(null, 200);
  });

  return Object.assign(app, { idle: () => bg.idle() });
}
