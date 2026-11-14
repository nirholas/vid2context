/**
 * Point the Telegram bot at this server: setWebhook with TELEGRAM_WEBHOOK_SECRET,
 * the /video and /help command menu, then getWebhookInfo.
 *
 *   npm run -w packages/bots setup:telegram
 *
 * Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and BOTS_PUBLIC_BASE_URL from the environment or .env.
 */
import { setupTelegram } from '../src/setup.ts';
import { fail, scriptContext } from './env.ts';

try {
  for (const line of await setupTelegram(scriptContext())) console.error(line);
} catch (err) {
  fail(err);
}
