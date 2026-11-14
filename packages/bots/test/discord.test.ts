import type { Route } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { discordKeys, fixtureJson, formField, harness, readFixture, VIDEO_URL } from './helpers.ts';

// The slash command example interaction from Discord's application commands docs (see fixtures/README.md).
const docsInteraction = fixtureJson<Record<string, unknown>>('discord-interaction-command.json');
const videoCommand = (url: string) => ({
  ...docsInteraction,
  data: { type: 1, name: 'video', id: '771825006014889984', options: [{ type: 3, name: 'url', value: url }] },
});

const APP_ID = '1234567890123456789';
const EDIT_URL = `https://discord.com/api/v10/webhooks/${APP_ID}/A_UNIQUE_TOKEN/messages/@original`;
// Discord's documented example Message object, the body of a successful edit.
const edited = { body: readFixture('discord-message.json'), headers: { 'content-type': 'application/json' } };

async function setup(
  extraEnv: Record<string, string> = {},
  routes: Route[] = [{ method: 'PATCH', url: EDIT_URL, response: edited }],
) {
  const keys = await discordKeys();
  const h = harness({ DISCORD_APPLICATION_ID: APP_ID, DISCORD_PUBLIC_KEY: keys.publicKeyHex, ...extraEnv }, routes);
  const send = async (payload: unknown, opts: { tamper?: boolean } = {}) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await keys.sign(timestamp, body);
    return h.app.request('/bots/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
      body: opts.tamper ? body.replace('A_UNIQUE_TOKEN', 'B_UNIQUE_TOKEN') : body,
    });
  };
  return { h, send };
}

describe('POST /bots/discord', () => {
  it('is off (404) without DISCORD_PUBLIC_KEY and DISCORD_APPLICATION_ID', async () => {
    const h = harness({ DISCORD_APPLICATION_ID: APP_ID });
    expect((await h.app.request('/bots/discord', { method: 'POST', body: '{"type":1}' })).status).toBe(404);
  });

  it('answers PING with PONG', async () => {
    const { send } = await setup();
    const res = await send({ type: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it('rejects a bad signature with 401 and no body', async () => {
    const { h, send } = await setup();
    const res = await send(docsInteraction, { tamper: true });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    const unsigned = await h.app.request('/bots/discord', { method: 'POST', body: JSON.stringify({ type: 1 }) });
    expect(unsigned.status).toBe(401);
  });

  it('answers commands it does not own with an ephemeral note', async () => {
    const { send } = await setup();
    const body = (await (await send(docsInteraction)).json()) as { type: number; data: { flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
  });

  it('defers, then edits the original response with the summary embed and the transcript file', async () => {
    const { h, send } = await setup();
    const res = await send(videoCommand(VIDEO_URL));
    expect(await res.json()).toEqual({ type: 5 });
    await h.settle();
    expect(h.llm.mismatch).toBeUndefined();

    const [edit] = h.calls(/discord\.com/);
    expect(edit).toMatchObject({ method: 'PATCH', url: EDIT_URL });
    const payload = JSON.parse(await formField(edit?.body, 'payload_json')) as {
      embeds: { title: string; url: string; description: string; footer: { text: string } }[];
      attachments: { id: number; filename: string }[];
      allowed_mentions: { parse: string[] };
    };
    const embed = payload.embeds[0];
    expect(embed?.url).toBe(VIDEO_URL);
    const bullets = (embed?.description ?? '').split('\n').filter((l) => l.startsWith('- '));
    expect(bullets.length).toBeGreaterThanOrEqual(5);
    for (const b of bullets)
      expect(b).toMatch(/\[\[\d+:\d{2}\]\]\(<https:\/\/www\.youtube\.com\/watch\?v=cCPsdFdlshc&t=\d+s>\)$/);
    expect(embed?.footer.text).toBe('Transcript attached (auto-captions, en, 521 lines).');
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.attachments[0]).toMatchObject({ id: 0, filename: expect.stringMatching(/-transcript\.txt$/) });
    expect(await formField(edit?.body, 'files[0]')).toContain('Transcript: auto-captions, en');
  });

  it('tells the user what failed, with the hint, when the video cannot be had', async () => {
    const { h, send } = await setup();
    expect(await (await send(videoCommand('https://www.youtube.com/watch?v=xxxxxxxxxxx'))).json()).toEqual({ type: 5 });
    await h.settle();
    const [edit] = h.calls(/discord\.com/);
    const content = (JSON.parse(String(edit?.body)) as { content: string }).content;
    expect(content).toContain('Could not summarize');
    expect(content).toContain('Check the video id or URL');
  });

  it('refuses local files and enforces the guild allowlist and rate limit, all ephemerally', async () => {
    const { h, send } = await setup({ BOTS_RATE_LIMIT_PER_HOUR: '1' });
    const local = (await (await send(videoCommand('/home/user/talk.mp3'))).json()) as { data: { content: string } };
    expect(local.data.content).toContain('Only links to online videos are accepted.');
    expect(((await (await send(videoCommand(VIDEO_URL))).json()) as { type: number }).type).toBe(5);
    const limited = (await (await send(videoCommand(VIDEO_URL))).json()) as { data: { content: string; flags: number } };
    expect(limited.data).toMatchObject({ flags: 64, content: expect.stringContaining('limit of 1 videos per hour') });
    await h.settle();

    const other = await setup({ BOTS_ALLOWED_GUILDS: '111111111111111111' });
    const refused = (await (await other.send(videoCommand(VIDEO_URL))).json()) as { data: { content: string } };
    expect(refused.data.content).toContain('This bot is not enabled for this server.');
  });

  it('logs when Discord rejects the edit (expired or unknown interaction token)', async () => {
    // Real response from discord.com for an interaction token that does not exist.
    const unknown = { status: 404, body: readFixture('discord-404-unknown-webhook.json') };
    const { h, send } = await setup({}, [{ method: 'PATCH', url: EDIT_URL, response: unknown }]);
    await send(videoCommand(VIDEO_URL));
    await h.settle();
    const errors = h.logs.filter((l) => l.level === 'error');
    expect(errors[0]).toMatchObject({ msg: 'bots: discord reply failed' });
    expect(String(errors[0]?.data?.error)).toContain('Unknown Webhook');
    expect(errors[1]?.msg).toBe('bots: discord reply: could not tell the user about the failure');
  });
});
