/**
 * @vid2context/bots: Telegram, Discord and Slack bots that answer a video link
 * with a timestamp-cited summary and the full transcript as a text file.
 * Mount `botsRoutes(deps)` under /api/v1; see README.md for platform setup.
 */
export { Background, backgroundCtx, type WaitUntil } from './background.ts';
export * from './config.ts';
export { type BotsApp, type BotsDeps, botsRoutes } from './http.ts';
export { extractSlackUrls, extractUrls, looksLocal, pickVideo, resolveVideo } from './input.ts';
export { RateLimiter, SeenIds } from './ratelimit.ts';
export { buildReply, describeError, replyFromContext, type UserError, type VideoReply } from './reply.ts';
export { botUrls, setupDiscord, setupTelegram, slackManifest } from './setup.ts';
export { buildSummaryRequest, parseSummary, SUMMARY_SYSTEM_PROMPT, summarize } from './summary.ts';
export { verifyDiscord, verifySlack, verifyTelegram } from './verify.ts';
