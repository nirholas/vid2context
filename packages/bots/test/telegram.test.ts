import { describe, expect, it } from 'vitest';
import { fixtureJson, formField, harness, readFixture, VIDEO_URL } from './helpers.ts';

// The "Message with text" example update from https://core.telegram.org/bots/webhooks (see fixtures/README.md).
const docsUpdate = fixtureJson<{ update_id: number; message: Record<string, unknown> & { text: string } }>(
  'telegram-update-text.json',
);
const withText = (text: string, update_id = docsUpdate.update_id) => ({
  ...docsUpdate,
  update_id,
  message: { ...docsUpdate.message, text },
});

const TOKEN = '123456:invalid-token-for-recording';
const SECRET = 'webhook_secret-for-tests';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET };
const API = /^https:\/\/api\.telegram\.org\/bot123456:invalid-token-for-recording\//;

// The documented success envelope around the documented Message object.
const ok = { body: readFixture('telegram-ok-message.json'), headers: { 'content-type': 'application/json' } };
const telegramOk = [
  { method: 'POST', url: /\/sendMessage$/, response: ok },
  { method: 'POST', url: /\/sendDocument$/, response: ok },
];

function post(h: ReturnType<typeof harness>, body: unknown, secret: string | null = SECRET) {
  return h.app.request('/bots/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret }) },
    body: JSON.stringify(body),
  });
}

describe('POST /bots/telegram', () => {
  it('is off (404) until the token and secret are set', async () => {
    const h = harness({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect((await post(h, docsUpdate)).status).toBe(404);
  });

  it('rejects a wrong or missing secret token with 401 and no body', async () => {
    const h = harness(ENV);
    const wrong = await post(h, docsUpdate, 'webhook_secret-for-testz');
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toBe('');
    expect((await post(h, docsUpdate, null)).status).toBe(401);
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('answers /start with help, inside the webhook response', async () => {
    const h = harness(ENV);
    const res = await post(h, docsUpdate);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ method: 'sendMessage', chat_id: 1111111, parse_mode: 'HTML' });
    expect(String(body.text)).toContain('Send me a video link');
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('replies to a link with the cited summary and the transcript file', async () => {
    const h = harness(ENV, telegramOk);
    const res = await post(h, withText(`have a look ${VIDEO_URL}`));
    expect(await res.json()).toEqual({ method: 'sendChatAction', chat_id: 1111111, action: 'typing' });
    await h.settle();
    expect(h.llm.mismatch).toBeUndefined();

    const [msg, doc] = h.calls(API);
    expect(msg?.url).toMatch(/\/sendMessage$/);
    const sent = JSON.parse(String(msg?.body)) as {
      text: string;
      parse_mode: string;
      reply_parameters: unknown;
      chat_id: number;
    };
    expect(sent).toMatchObject({ chat_id: 1111111, parse_mode: 'HTML', reply_parameters: { message_id: 1365 } });
    expect(sent.text).toContain('<b><a href="https://www.youtube.com/watch?v=cCPsdFdlshc">');
    const bullets = sent.text.split('\n').filter((l) => l.startsWith('• '));
    expect(bullets.length).toBeGreaterThanOrEqual(5);
    expect(bullets.length).toBeLessThanOrEqual(8);
    for (const b of bullets)
      expect(b).toMatch(/<a href="https:\/\/www\.youtube\.com\/watch\?v=cCPsdFdlshc&amp;t=\d+s">\[\d+:\d{2}\]<\/a>$/);
    expect(sent.text).toContain('Transcript attached (auto-captions, en, 521 lines).');

    expect(doc?.url).toMatch(/\/sendDocument$/);
    const file = await formField(doc?.body, 'document');
    expect(file).toContain('[0:00]');
    expect(file.split('\n').filter((l) => /^\[\d+:\d{2}\] /.test(l))).toHaveLength(521);
    expect(await formField(doc?.body, 'reply_parameters')).toBe(
      JSON.stringify({ message_id: 1365, allow_sending_without_reply: true }),
    );
    const form = doc?.body as FormData;
    expect(form.get('document')).toHaveProperty('name', expect.stringMatching(/-transcript\.txt$/));
  });

  it('still sends the transcript when no LLM is available, and says why the summary is missing', async () => {
    const h = harness({ ...ENV, VID2CONTEXT_KEYLESS: '0' }, telegramOk);
    await post(h, withText(VIDEO_URL));
    await h.settle();
    const [msg, doc] = h.calls(API);
    const text = JSON.parse(String(msg?.body)).text as string;
    expect(text).toContain('<i>Summary unavailable: No llm rung is enabled.');
    expect(doc?.url).toMatch(/\/sendDocument$/);
  });

  it('refuses local files without touching the network', async () => {
    const h = harness(ENV, telegramOk);
    const texts = ['/video /etc/passwd', '/video talk.mp3', '/video file:///etc/hostname'];
    for (const [i, text] of texts.entries()) {
      const body = (await (await post(h, withText(text, 30000 + i))).json()) as { method: string; text: string };
      expect(body.method).toBe('sendMessage');
      expect(body.text).toContain('Only links to online videos are accepted.');
    }
    await h.settle();
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('limits requests per chat and user, and ignores redelivered updates', async () => {
    const h = harness({ ...ENV, BOTS_RATE_LIMIT_PER_HOUR: '1' }, telegramOk);
    expect(((await (await post(h, withText(VIDEO_URL, 20001))).json()) as { method: string }).method).toBe('sendChatAction');
    // Telegram redelivers an update it did not get a 2xx for; the same update_id is not processed again.
    const again = await post(h, withText(VIDEO_URL, 20001));
    expect(again.status).toBe(200);
    expect(await again.text()).toBe('');
    const limited = (await (await post(h, withText(VIDEO_URL, 20002))).json()) as { text: string };
    expect(limited.text).toContain('The limit of 1 videos per hour is reached.');
    await h.settle();
    expect(h.calls(/\/sendMessage$/)).toHaveLength(1);
  });

  it('honours BOTS_ALLOWED_CHATS', async () => {
    const h = harness({ ...ENV, BOTS_ALLOWED_CHATS: '-1001234567890' });
    const body = (await (await post(h, withText(VIDEO_URL))).json()) as { text: string };
    expect(body.text).toContain('This bot is not enabled for this chat.');
  });

  it('logs a failed Bot API call (never the token) and tries to tell the user', async () => {
    // Real response from api.telegram.org for a token that does not exist.
    const unauthorized = { status: 401, body: readFixture('telegram-401.json') };
    const h = harness(ENV, [{ method: 'POST', url: /\/sendMessage$/, response: unauthorized }]);
    await post(h, withText(VIDEO_URL));
    await h.settle();
    const errors = h.logs.filter((l) => l.level === 'error');
    expect(errors.map((e) => e.msg)).toEqual([
      'bots: telegram reply failed',
      'bots: telegram reply: could not tell the user about the failure',
    ]);
    expect(errors[0]?.data?.error).toBe('Telegram sendMessage: Unauthorized');
    expect(JSON.stringify(h.logs)).not.toContain('invalid-token-for-recording');
  });
});
