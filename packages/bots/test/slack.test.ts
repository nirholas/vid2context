import { describe, expect, it } from 'vitest';
import { fixtureJson, harness, readFixture, slackHeaders, VIDEO_URL } from './helpers.ts';

const SECRET = 'slack-signing-secret-for-tests';
const ENV = { SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: 'xoxb-invalid-token-for-recording' };
const json = (name: string) => ({ body: readFixture(name), headers: { 'content-type': 'application/json' } });

// Slack's documented "typical success" responses for the three Web API methods, and the
// documented upload URL (the upload itself answers HTTP 200, as the files docs describe).
const UPLOAD_URL = 'https://files.slack.com/upload/v1/ABC123...';
const slackOk = [
  { method: 'POST', url: 'https://slack.com/api/chat.postMessage', response: json('slack-chat-postmessage.json') },
  {
    method: 'POST',
    url: 'https://slack.com/api/files.getUploadURLExternal',
    response: json('slack-files-getuploadurlexternal.json'),
  },
  { method: 'POST', url: UPLOAD_URL, response: { status: 200, body: '' } },
  {
    method: 'POST',
    url: 'https://slack.com/api/files.completeUploadExternal',
    response: json('slack-files-completeuploadexternal.json'),
  },
];

// The documented slash command payload, with its text set to a link as Slack sends it with escaping on.
const docsCommand = readFixture('slack-command.txt').trim();
const command = (text: string) => {
  const form = new URLSearchParams(docsCommand);
  form.set('text', text);
  return form.toString();
};
const mention = fixtureJson<{ event: { text: string } & Record<string, unknown> } & Record<string, unknown>>(
  'slack-app-mention.json',
);
const withMentionText = (text: string, event_id = 'Ev123ABC456') => ({ ...mention, event_id, event: { ...mention.event, text } });

async function post(h: ReturnType<typeof harness>, path: string, body: string, at = Math.floor(Date.now() / 1000)) {
  return h.app.request(path, { method: 'POST', body, headers: await slackHeaders(SECRET, body, at) });
}

describe('Slack routes', () => {
  it('are off (404) until the signing secret and bot token are set', async () => {
    const h = harness({ SLACK_SIGNING_SECRET: SECRET });
    expect((await post(h, '/bots/slack/events', '{}')).status).toBe(404);
    expect((await post(h, '/bots/slack/commands', command(VIDEO_URL))).status).toBe(404);
  });

  it('reject a bad signature and a stale timestamp with 401', async () => {
    const h = harness(ENV);
    const body = command(VIDEO_URL);
    const bad = await h.app.request('/bots/slack/commands', {
      method: 'POST',
      body,
      headers: { ...(await slackHeaders('another-secret', body, Math.floor(Date.now() / 1000))) },
    });
    expect(bad.status).toBe(401);
    expect(await bad.text()).toBe('');
    const stale = await post(h, '/bots/slack/commands', body, Math.floor(Date.now() / 1000) - 301);
    expect(stale.status).toBe(401);
    expect((await h.app.request('/bots/slack/events', { method: 'POST', body: '{}' })).status).toBe(401);
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('answer url_verification with the challenge', async () => {
    const h = harness(ENV);
    const res = await post(h, '/bots/slack/events', readFixture('slack-url-verification.json'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P');
  });

  it('ack a slash command at once, then post the summary and upload the transcript into its thread', async () => {
    const h = harness(ENV, slackOk);
    const res = await post(h, '/bots/slack/commands', command(`<${VIDEO_URL}>`));
    expect(await res.json()).toEqual({
      response_type: 'ephemeral',
      text: `Working on ${VIDEO_URL}. The summary and transcript will be posted here shortly.`,
    });
    await h.settle();
    expect(h.llm.mismatch).toBeUndefined();

    const [post1, ticket, upload, complete] = h.calls(/slack\.com/);
    expect(post1?.headers.authorization).toBe('Bearer xoxb-invalid-token-for-recording');
    const message = JSON.parse(String(post1?.body)) as { channel: string; text: string; unfurl_links: boolean };
    expect(message).toMatchObject({ channel: 'C2147483705', unfurl_links: false });
    expect(message.text.startsWith(`*<${VIDEO_URL}|`)).toBe(true);
    const bullets = message.text.split('\n').filter((l) => l.startsWith('• '));
    expect(bullets.length).toBeGreaterThanOrEqual(5);
    for (const b of bullets) expect(b).toMatch(/<https:\/\/www\.youtube\.com\/watch\?v=cCPsdFdlshc&t=\d+s\|\[\d+:\d{2}\]>$/);

    expect(ticket?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(String(ticket?.body));
    expect(params.get('filename')).toMatch(/-transcript\.txt$/);
    const bytes = upload?.body as Uint8Array;
    expect(new TextDecoder().decode(bytes)).toContain('[0:00]');
    expect(Number(params.get('length'))).toBe(bytes.byteLength);
    expect(JSON.parse(String(complete?.body))).toMatchObject({
      files: [{ id: 'F123ABC456' }],
      channel_id: 'C123ABC456',
      thread_ts: '1503435956.000247',
      initial_comment: 'Full transcript (auto-captions, en, 521 lines).',
    });
  });

  it('send slash command errors back through response_url, with the hint', async () => {
    // Real chat.postMessage response from slack.com for a bot token that does not exist.
    const h = harness(ENV, [
      { method: 'POST', url: 'https://slack.com/api/chat.postMessage', response: json('slack-invalid-auth.json') },
      { method: 'POST', url: 'https://hooks.slack.com/commands/1234/5678', response: { status: 200, body: 'ok' } },
    ]);
    await post(h, '/bots/slack/commands', command(VIDEO_URL));
    await h.settle();
    const [hook] = h.calls(/hooks\.slack\.com/);
    const sent = JSON.parse(String(hook?.body)) as { response_type: string; text: string };
    expect(sent.response_type).toBe('ephemeral');
    expect(sent.text).toContain('Slack chat.postMessage: invalid_auth');
    expect(sent.text).toContain('Check SLACK_BOT_TOKEN');
  });

  it('refuse local files and empty commands ephemerally, without any outbound call', async () => {
    const h = harness(ENV, slackOk);
    for (const text of ['/etc/passwd', 'talk.mp3', 'file:///etc/hostname']) {
      const body = (await (await post(h, '/bots/slack/commands', command(text))).json()) as { text: string };
      expect(body.text).toContain('Only links to online videos are accepted.');
    }
    const help = (await (await post(h, '/bots/slack/commands', command(''))).json()) as { text: string };
    expect(help.text).toContain('/vid2context <video link>');
    await h.settle();
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('answer a mention without a link with help, in a thread', async () => {
    const h = harness(ENV, slackOk);
    expect((await post(h, '/bots/slack/events', JSON.stringify(mention))).status).toBe(200);
    await h.settle();
    const [reply] = h.calls(/chat\.postMessage/);
    expect(JSON.parse(String(reply?.body))).toMatchObject({
      channel: 'C123ABC456',
      thread_ts: '1515449522.000016',
      text: expect.stringContaining('/vid2context <video link>'),
    });
  });

  it('answer a mention with a link in its thread, once even when Slack retries', async () => {
    const h = harness(ENV, slackOk);
    const body = JSON.stringify(withMentionText(`<@U0LAN0Z89> summarize <${VIDEO_URL}>`, 'Ev0MDYHUEL'));
    expect((await post(h, '/bots/slack/events', body)).status).toBe(200);
    expect((await post(h, '/bots/slack/events', body)).status).toBe(200);
    await h.settle();
    const posts = h.calls(/chat\.postMessage/);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.body))).toMatchObject({ thread_ts: '1515449522.000016' });
    expect(JSON.parse(String(h.calls(/completeUploadExternal/)[0]?.body))).toMatchObject({ thread_ts: '1515449522.000016' });
  });

  it('answer direct messages at the top level and enforce the team allowlist', async () => {
    const im = fixtureJson<{ event: Record<string, unknown> } & Record<string, unknown>>('slack-message-im.json');
    const h = harness({ ...ENV, BOTS_ALLOWED_TEAMS: 'T999' }, slackOk);
    const body = JSON.stringify({ ...im, event: { ...im.event, text: `<${VIDEO_URL}>` } });
    await post(h, '/bots/slack/events', body);
    await h.settle();
    const [reply] = h.calls(/chat\.postMessage/);
    const sent = JSON.parse(String(reply?.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ channel: 'D024BE91L', text: expect.stringContaining('not enabled for this workspace') });
    expect(sent.thread_ts).toBeUndefined();
  });
});
