/**
 * Register the /video slash command for the Discord app.
 *
 *   npm run -w packages/bots setup:discord                  global command (can take a while to show up)
 *   npm run -w packages/bots setup:discord -- --guild <id>  one server, available at once
 *   npm run -w packages/bots setup:discord -- --endpoint    also set the interactions endpoint URL
 *
 * Reads DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN and BOTS_PUBLIC_BASE_URL from the environment or .env.
 */
import { parseArgs } from 'node:util';
import { setupDiscord } from '../src/setup.ts';
import { fail, scriptContext } from './env.ts';

try {
  const { values } = parseArgs({ options: { guild: { type: 'string' }, endpoint: { type: 'boolean' } } });
  for (const line of await setupDiscord(scriptContext(), { guildId: values.guild, setEndpoint: values.endpoint })) {
    console.error(line);
  }
} catch (err) {
  fail(err);
}
