# @vid2context/bots

Chat bots for Telegram, Discord and Slack. Send a video link and the bot replies with the title, a 5 to 8 bullet summary where every bullet links to the moment it describes (`[m:ss]`), and the full transcript as a `.txt` file.

The bots are webhook routes on the same server or Cloudflare Worker as the HTTP API. They are free to run: all three platforms are free for bots, and the summary uses vid2context's free-first LLM chain (local models, then free tiers with your key, then keyless hosts).

## Routes

`botsRoutes(deps)` in `src/http.ts` returns a Hono sub-app. Mount it under `/api/v1`:

```ts
import { botsRoutes } from '@vid2context/bots';

app.route('/api/v1', botsRoutes({ registry, makeCtx }));
// Workers: pass waitUntil explicitly, or leave it out and the request's executionCtx is used.
```

| Route | Platform | Verified by |
|---|---|---|
| `POST /api/v1/bots/telegram` | Telegram updates | `X-Telegram-Bot-Api-Secret-Token` equals `TELEGRAM_WEBHOOK_SECRET` (constant-time compare) |
| `POST /api/v1/bots/discord` | Discord interactions | Ed25519 signature over timestamp plus body, with `DISCORD_PUBLIC_KEY` |
| `POST /api/v1/bots/slack/events` | Slack Events API | `v0` HMAC-SHA256 with `SLACK_SIGNING_SECRET`; timestamps more than 5 minutes off are refused |
| `POST /api/v1/bots/slack/commands` | Slack slash command | same as events |

Verification runs on the raw body before anything is parsed. A failed check gets `401` with no body. A platform whose secrets are not set answers `404`, so an unconfigured bot is simply not there.

`deps`: `registry` and `makeCtx` as for every route factory; optional `waitUntil` (keeps background work alive, Workers `executionCtx.waitUntil`), `storage` (a cache, so a video already summarized is not fetched again), `chain` (LLM chain options) and `now` (clock, for tests). The returned app has `idle()`, which resolves once all background work has settled (use it for graceful shutdown on Node).

## How a request is handled

1. Verify the request, then answer within the platform's deadline: Telegram gets `200` with a "typing" action, Discord gets a deferred response (type 5, the user sees "thinking"), Slack gets an immediate acknowledgement.
2. Check the allowlist, that the input is one online video (never a local path or `file:` URL), and the rate limit. Refusals are answered at once, without starting any work.
3. In the background: fetch the video context through the normal pipeline, ask the LLM chain for the bullets, keep only timestamps that match real transcript segments, and send the reply with the transcript attached. If the summary fails, the transcript is still sent with a line saying why. If the video fails, the user gets the error and its recovery hint.

## Setup

First run the server somewhere the platforms can reach over HTTPS: a deployed Worker, Cloud Run, or your machine behind a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8787`). Set `BOTS_PUBLIC_BASE_URL` to that public origin, for example `https://v2c.example.com`. The setup scripts add `/api/v1/bots/...` themselves. They read keys from the environment or `.env` and print what they did, never the keys.

### Telegram

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Make a webhook secret: `openssl rand -hex 32` into `TELEGRAM_WEBHOOK_SECRET` (Telegram allows `A-Z a-z 0-9 _ -`, up to 256 characters).
3. Restart the server with both set.
4. Run `npm run -w packages/bots setup:telegram`. It calls `setWebhook` with the secret (updates: `message` only), sets the `/video` and `/help` command menu, and prints `getWebhookInfo`.

In private chats the bot answers any message with a link. In groups it answers `/video <link>` and replies to its own messages; it does not read every link in a group.

### Discord

1. In the [Developer Portal](https://discord.com/developers/applications) create an application. From General Information copy the Application ID into `DISCORD_APPLICATION_ID` and the Public Key into `DISCORD_PUBLIC_KEY`. From Bot, reset and copy the token into `DISCORD_BOT_TOKEN` (only the setup script uses it).
2. Restart the server with `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` set.
3. Run `npm run -w packages/bots setup:discord -- --endpoint`. It registers `/video` (with a required `url` option) and sets the Interactions Endpoint URL; Discord sends a signed PING to that URL first, so the server must be reachable. Add `--guild <server id>` to register in one server at once (global commands can take a while to appear).
4. Invite the app: OAuth2, URL Generator, scope `applications.commands`, then open the generated link.

Use it with `/video url:<link>`.

### Slack

1. Run `npm run -s -w packages/bots setup:slack > slack-manifest.json`. It prints an app manifest with your URLs: the `/vid2context` command, the `app_mention` and `message.im` events, and the scopes `commands`, `chat:write`, `files:write`, `app_mentions:read`, `im:history`.
2. At [api.slack.com/apps](https://api.slack.com/apps), Create New App, From a manifest, paste it, and install the app to your workspace.
3. Copy the Signing Secret (Basic Information) into `SLACK_SIGNING_SECRET` and the Bot User OAuth Token (`xoxb-...`, OAuth & Permissions) into `SLACK_BOT_TOKEN`, then restart the server. Slack verifies the events URL when you save it; the route answers the `url_verification` challenge.

Use `/vid2context <link>`, mention the app with a link in a channel (it answers in the thread), or send it a link in a direct message. The summary is posted to the channel and the transcript is uploaded into the summary's thread. If the app is not in the channel, the summary comes through the command's `response_url` instead, with a note to `/invite` the app for the file.

## Environment

| Variable | Needed for | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram | token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram | secret sent back in `X-Telegram-Bot-Api-Secret-Token` |
| `DISCORD_APPLICATION_ID` | Discord | application id, used for the followup webhook |
| `DISCORD_PUBLIC_KEY` | Discord | hex public key, verifies interactions |
| `DISCORD_BOT_TOKEN` | Discord setup script | registers the slash command; the server does not need it |
| `SLACK_SIGNING_SECRET` | Slack | verifies requests |
| `SLACK_BOT_TOKEN` | Slack | `xoxb-` token for posting and uploading |
| `BOTS_PUBLIC_BASE_URL` | setup scripts | public HTTPS origin of the server |
| `BOTS_ALLOWED_CHATS` | optional | comma-separated Telegram chat ids; when set, only these chats are served |
| `BOTS_ALLOWED_GUILDS` | optional | comma-separated Discord server ids (direct messages are refused when set) |
| `BOTS_ALLOWED_TEAMS` | optional | comma-separated Slack team ids |
| `BOTS_RATE_LIMIT_PER_HOUR` | optional | videos per hour per chat and per user, default 10; 0 turns the bots off for everyone |

The summary model follows the usual chain settings (`VID2CONTEXT_POLICY`, `VID2CONTEXT_SKIP`, `<PROVIDER>_MODEL`, and the keys in [docs/providers.md](../../docs/providers.md)).

## Limits

- Rate limits are counted in memory, per server instance (per isolate on Workers): a guard against one chat flooding the bot, not a global quota. Only requests that start work count.
- The transcript sent to the model is capped at about 24,000 characters (roughly 6k tokens, under the per-minute caps of the free tiers). Longer videos are summarized from evenly spaced excerpts across the whole video; the attached transcript is always complete.
- Platform message limits: Telegram 4096 characters, Discord embeds 4096, Slack about 4000. Bullets that do not fit are dropped whole, never cut mid-link.
- Discord interaction tokens last 15 minutes; background work for Discord stops at 14 minutes. Other platforms get 20 minutes, which covers speech-to-text for videos without captions.
- Only single online videos: playlists and channels are refused, and local paths or `file:` URLs are refused before any source sees them.

## Privacy

- Logged (to stderr through `ctx.log`): the platform, the video id, how many bullets, which LLM rung answered, and error messages from failed steps.
- Not logged: message text, user names, user or chat ids, tokens, secrets, request signatures. Bot API URLs contain the Telegram token, so they never appear in errors or logs.
- Held in memory only: rate-limit counters keyed by chat and user id, and recently seen update and event ids (to ignore platform retries). Nothing is written to disk unless you pass a `storage`, which caches video contexts (public video data), not chat data.
- The transcript is sent to the LLM rung that writes the summary. Set `VID2CONTEXT_POLICY=local-only` to keep it on your own machine, or `VID2CONTEXT_KEYLESS=0` to avoid keyless hosts.

## Runtimes

Node 22+ and Cloudflare Workers, with `fetch` and WebCrypto only. Ed25519 verification uses `crypto.subtle` with the standard `Ed25519` algorithm name, which works on Node 22 (checked on 22.23.5) and Node 24, and in workerd (checked with wrangler's local workerd 1.20261023.1, where the routes answered a signed PING and the Slack challenge).

## Tests

`npx vitest run packages/bots` replays everything: the shared YouTube fixtures, a recorded keyless LLM answer for the exact summary prompt, and documented or recorded platform payloads (see [test/fixtures/README.md](test/fixtures/README.md)). `LIVE=1` adds a live summary through the keyless chain. Re-record the LLM fixture with `LIVE=1 npm run -w packages/bots record` after changing the prompt.
