# Bots fixtures

No bot token was available, so no request was delivered by a real bot. Every payload here is either copied from the platform's official docs (URL given) or recorded from the real service on 2026-11-14 from this repo's VM. Documentation pages were fetched on 2026-11-14. Nothing personal is in these files: the docs examples use placeholder people and ids, and the recordings used tokens that do not exist.

The route tests also replay the shared YouTube fixtures in `providers/youtube/test/fixtures/` (player and timedtext for `cCPsdFdlshc` and `jNQXAC9IVRw`, and `player-unavailable.json`).

## Recorded from the real service

| File | Source |
|---|---|
| `llm-summary-cCPsdFdlshc.json` | Keyless OVH AI Endpoints, `Meta-Llama-3_3-70B-Instruct`, no key. The request is the exact summary request `buildSummaryRequest` builds for `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (the route tests rebuild that context from the YouTube fixtures and must send the same request, or the replay refuses). Recorded with `LIVE=1 npm run -w packages/bots record`. Stores the URL, the request body, the status and the response body; no headers. |
| `telegram-401.json` | `POST https://api.telegram.org/bot123456:invalid-token-for-recording/sendMessage` (and `/setWebhook`, same answer), HTTP 401. |
| `discord-404-unknown-webhook.json` | `PATCH https://discord.com/api/v10/webhooks/1234567890123456789/A_UNIQUE_TOKEN/messages/@original`, HTTP 404: what Discord answers for an unknown or expired interaction token. |
| `discord-401.json` | `PUT https://discord.com/api/v10/applications/1234567890123456789/commands` with `Authorization: Bot invalid-token-for-recording`, HTTP 401. |
| `slack-invalid-auth.json` | `POST https://slack.com/api/chat.postMessage` with `Authorization: Bearer xoxb-invalid-token-for-recording`, HTTP 200 with `ok: false` (`files.getUploadURLExternal` answers the same). |

## Copied from the official docs

| File | Source | Changes |
|---|---|---|
| `slack-signing-vector.json` | The worked example in [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/): signing secret, timestamp `1531420618`, request body and the expected `v0=` signature. Slack's published test vector. | none |
| `slack-command.txt` | "Payload example" in [Implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/) (the `/weather 94070` command). | none; tests replace the `text` field with a video link |
| `slack-app-mention.json` | First example (event wrapper and event) in [app_mention](https://docs.slack.dev/reference/events/app_mention/). | trailing commas removed so it parses |
| `slack-message-im.json` | Example in [message.im](https://docs.slack.dev/reference/events/message.im/). | trailing commas removed; tests replace `text` with a link |
| `slack-url-verification.json` | Example in [url_verification](https://docs.slack.dev/reference/events/url_verification/). | none |
| `slack-chat-postmessage.json` | "Response" example in [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/). | none |
| `slack-files-getuploadurlexternal.json` | "Typical success response" in [files.getUploadURLExternal](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/). Its `upload_url` (`https://files.slack.com/upload/v1/ABC123...`) is the URL the tests upload to; the docs say the upload answers HTTP 200, which is all the code checks. | none |
| `slack-files-completeuploadexternal.json` | "Typical success response" in [files.completeUploadExternal](https://docs.slack.dev/reference/methods/files.completeUploadExternal/). | none |
| `discord-interaction-command.json` | "Slash Command Interaction" example in [Application Commands](https://discord.com/developers/docs/interactions/application-commands#slash-commands-example-interaction) (source: `developers/interactions/application-commands.mdx` in github.com/discord/discord-api-docs). | none; tests replace `data` with the `/video url:<link>` command |
| `discord-message.json` | "Example Message" in [Message resource](https://discord.com/developers/docs/resources/message#message-object-example-message), the body Discord returns for a successful edit. | the reaction emoji is written as a JSON escape |
| `telegram-update-text.json` | "Message with text" in the "More examples in curl" list of [Marvin's Marvellous Guide to All Things Webhook](https://core.telegram.org/bots/webhooks#testing-your-bot-with-updates). | none; tests replace `text` (and `update_id`) |
| `telegram-ok-message.json` | Telegram publishes no example API responses. This is the envelope the [Bot API](https://core.telegram.org/bots/api#making-requests) documents (`ok: true`, the result in `result`) around the Message object from `telegram-update-text.json`, which is what sendMessage and sendDocument return. | assembled from the two documented pieces |

Discord PING: the docs describe only `type: 1`, so the test sends `{"type":1}`. Discord's request signatures and Telegram's secret header have no published vectors: tests generate a real Ed25519 key pair with WebCrypto and sign the documented bodies, and send the secret header as Telegram does.

## Re-recording

- `llm-summary-cCPsdFdlshc.json`: `LIVE=1 npm run -w packages/bots record` whenever the summary prompt changes (the route tests say so when it has). Keyless rungs allow about 2 requests per minute per IP; retry after a minute when rate-limited.
- The error responses: send the same requests with a token that does not exist and keep only the body.
