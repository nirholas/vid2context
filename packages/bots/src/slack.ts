/**
 * Slack: the `/vid2context <link>` slash command and Events API mentions and
 * direct messages in; Web API calls out. Slack wants a 200 within 3 seconds,
 * so both routes ack first and post the reply afterwards.
 *
 * The reply is a chat.postMessage with the summary, then the transcript is
 * uploaded into that message's thread with the files upload v2 flow
 * (files.getUploadURLExternal, POST the bytes, files.completeUploadExternal).
 *
 * Reference: https://docs.slack.dev/apis/events-api/ and https://docs.slack.dev/messaging/working-with-files
 */
import { type Ctx, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import type { SlackConfig } from './config.ts';

export const SLACK_API = 'https://slack.com/api';
export const SLACK_COMMAND = '/vid2context';

export const SLACK_HELP =
  'Send `/vid2context <video link>` or mention me with a link, and I will reply with a short summary with timestamp links and attach the full transcript.';

/** A Slack Web API error, keeping Slack's own error string (for example `not_in_channel`). */
export class SlackApiError extends Vid2ContextError {
  readonly slackError: string;
  constructor(method: string, slackError: string, status?: number) {
    super(slackError === 'invalid_auth' || slackError === 'not_authed' ? 'auth' : 'upstream', `Slack ${method}: ${slackError}`, {
      status,
      hint:
        slackError === 'not_in_channel' || slackError === 'channel_not_found'
          ? 'Invite the app to the channel (/invite @vid2context) and try again.'
          : slackError === 'invalid_auth' || slackError === 'not_authed'
            ? 'Check SLACK_BOT_TOKEN (OAuth & Permissions in the Slack app settings).'
            : 'See the Slack error above.',
    });
    this.slackError = slackError;
  }
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function slackJson(res: Response, method: string): Promise<SlackResponse> {
  let data: SlackResponse;
  try {
    data = (await res.json()) as SlackResponse;
  } catch {
    throw new SlackApiError(method, `HTTP ${res.status}`, res.status);
  }
  if (!data.ok) throw new SlackApiError(method, data.error ?? `HTTP ${res.status}`, res.status);
  return data;
}

/** Call a Web API method with a JSON body. */
export async function slackCall(ctx: Ctx, cfg: SlackConfig, method: string, body: Record<string, unknown>) {
  const res = await fetchWithTimeout(
    ctx,
    `${SLACK_API}/${method}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    },
    30_000,
  );
  return slackJson(res, method);
}

/** Call a Web API method that only accepts form encoding (files.getUploadURLExternal). */
async function slackForm(ctx: Ctx, cfg: SlackConfig, method: string, params: Record<string, string>) {
  const res = await fetchWithTimeout(
    ctx,
    `${SLACK_API}/${method}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.botToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    30_000,
  );
  return slackJson(res, method);
}

export async function postMessage(
  ctx: Ctx,
  cfg: SlackConfig,
  msg: { channel: string; text: string; threadTs?: string },
): Promise<{ channel: string; ts: string }> {
  const data = await slackCall(ctx, cfg, 'chat.postMessage', {
    channel: msg.channel,
    text: msg.text,
    ...(msg.threadTs ? { thread_ts: msg.threadTs } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
  return { channel: String(data.channel ?? msg.channel), ts: String(data.ts ?? '') };
}

/** Upload a text file into a channel (and thread) with the files upload v2 flow. */
export async function uploadText(
  ctx: Ctx,
  cfg: SlackConfig,
  file: { filename: string; text: string; title: string },
  target: { channel: string; threadTs?: string; comment?: string },
): Promise<void> {
  const bytes = new TextEncoder().encode(file.text);
  const ticket = await slackForm(ctx, cfg, 'files.getUploadURLExternal', {
    filename: file.filename,
    length: String(bytes.byteLength),
  });
  const uploadUrl = String(ticket.upload_url ?? '');
  const fileId = String(ticket.file_id ?? '');
  if (!uploadUrl || !fileId) throw new SlackApiError('files.getUploadURLExternal', 'missing upload_url or file_id');
  const up = await fetchWithTimeout(
    ctx,
    uploadUrl,
    { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: bytes },
    60_000,
  );
  if (!up.ok) throw new SlackApiError('file upload', `HTTP ${up.status}`, up.status);
  await slackCall(ctx, cfg, 'files.completeUploadExternal', {
    files: [{ id: fileId, title: file.title }],
    channel_id: target.channel,
    ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
    ...(target.comment ? { initial_comment: target.comment } : {}),
  });
}

/** Post to a slash command's response_url (valid for 30 minutes, up to 5 times). No bot token needed. */
export async function respond(
  ctx: Ctx,
  responseUrl: string,
  msg: { text: string; inChannel?: boolean },
): Promise<void> {
  if (!/^https:\/\/hooks\.slack\.com\//.test(responseUrl)) {
    throw new Vid2ContextError('bad-request', 'Slack response_url is not a hooks.slack.com URL.');
  }
  const res = await fetchWithTimeout(
    ctx,
    responseUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_type: msg.inChannel ? 'in_channel' : 'ephemeral', text: msg.text }),
    },
    30_000,
  );
  if (!res.ok) throw new SlackApiError('response_url', `HTTP ${res.status}`, res.status);
}

export interface SlackEvent {
  type: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
}

export interface SlackEnvelope {
  type: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: SlackEvent;
}

/** Events the bot answers: mentions in channels and direct messages from people (never bots, never edits). */
export function wantedEvent(e: SlackEvent | undefined): e is SlackEvent & { channel: string; user: string } {
  if (!e?.channel || !e.user || e.bot_id || e.subtype) return false;
  return e.type === 'app_mention' || (e.type === 'message' && e.channel_type === 'im');
}
