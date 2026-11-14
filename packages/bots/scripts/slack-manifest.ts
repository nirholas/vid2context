/**
 * Print a Slack app manifest (JSON) with this server's webhook URLs. Paste it at
 * https://api.slack.com/apps, Create New App, From a manifest.
 *
 *   npm run -s -w packages/bots setup:slack > slack-manifest.json
 *
 * Reads BOTS_PUBLIC_BASE_URL from the environment or .env. The manifest goes to
 * stdout; the next steps go to stderr.
 */
import process from 'node:process';
import { slackManifest } from '../src/setup.ts';
import { fail, scriptContext } from './env.ts';

try {
  const manifest = slackManifest(scriptContext().env);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  console.error('Next: create the app from this manifest, install it to your workspace, then set');
  console.error('SLACK_SIGNING_SECRET (Basic Information) and SLACK_BOT_TOKEN (OAuth & Permissions, xoxb-...) on the server.');
} catch (err) {
  fail(err);
}
