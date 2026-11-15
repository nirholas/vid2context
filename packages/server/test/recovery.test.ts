/**
 * Failures are never dead ends: every error body carries `recovery`, and a
 * caller can retry with its own provider key (X-Vid2Context-Keys) without
 * the operator adding one. YouTube answers are real recordings
 * (providers/youtube/test/fixtures).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordedResponse } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { parseRequestKeys, requestKeyNames } from '../src/request-keys.ts';
import { makeApp, testRegistry } from './helpers.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const yt = (name: string) => readFileSync(join(root, 'providers', 'youtube', 'test', 'fixtures', name), 'utf8');
const json = (name: string): RecordedResponse => ({ body: yt(name), headers: { 'content-type': 'application/json' } });
const ZOO = 'jNQXAC9IVRw';
const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ZOO}`)}&format=json`;

/** YouTube answering this server with its bot check, as it does for many cloud IP addresses. */
const blockedRoutes = () => [
  { method: 'POST', url: /youtubei\/v1\/player/, response: json('player-android_vr-bot-jNQXAC9IVRw.json') },
  { method: 'POST', url: /youtubei\/v1\/next/, response: json('metadata/next-fallback-jNQXAC9IVRw.json') },
  { url: oembed, response: json('metadata/oembed-jNQXAC9IVRw.json') },
  { method: 'HEAD', url: `https://i.ytimg.com/vi/${ZOO}/maxresdefault.jpg`, response: { status: 404, body: '' } },
];

type Rung = { id: string; enabled: boolean };
const groqRung = (body: { providers: { rungs?: Rung[] }[] }) =>
  body.providers.flatMap((p) => p.rungs ?? []).find((r) => r.id === 'stt/groq/whisper-large-v3-turbo');

describe('recovery in error bodies', () => {
  it('answers a YouTube block with ways to still get the transcript, not just the error', async () => {
    const { app } = makeApp({ routes: blockedRoutes() });
    const res = await app.request(
      `/api/v1/context?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ZOO}`)}&mode=captions`,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('blocked');
    const actions = body.recovery.map((r: { action: string }) => r.action);
    // No yt-dlp downloads in this app and a loopback host: import, local file, retry, and installing yt-dlp.
    expect(actions).toEqual(['import-transcript', 'local-file', 'retry', 'install']);
    expect(body.recovery[1].detail).toContain('POST /uploads');
  });

  it('gives a fix-input recovery for a video that does not exist', async () => {
    const { app } = makeApp();
    const body = await (await app.request('/api/v1/context?url=xxxxxxxxxxx')).json();
    expect(body.error.code).toBe('not-found');
    expect(body.recovery[0]).toMatchObject({ action: 'fix-input' });
  });

  it('keeps recovery empty for credential errors, where the hint is the fix', async () => {
    const { app } = makeApp({ env: { VID2CONTEXT_API_KEYS: 'k1' } });
    const res = await app.request('/api/v1/formats');
    expect(res.status).toBe(401);
    expect((await res.json()).recovery).toEqual([]);
  });
});

describe('provider keys per request', () => {
  it('lists the accepted names: provider credentials only, never server settings or base URLs', () => {
    const names = requestKeyNames(testRegistry());
    expect(names).toContain('GROQ_API_KEY');
    expect(names.every((n) => /_(API_KEY|API_TOKEN|TOKEN|KEY|ACCOUNT_ID)$/.test(n))).toBe(true);
    expect(names.some((n) => n.startsWith('VID2CONTEXT_') || n.includes('BASE_URL') || n.includes('MODEL'))).toBe(false);
  });

  it('uses a key sent with the request for that request only, and never echoes it', async () => {
    const { app } = makeApp();
    const keys = JSON.stringify({ GROQ_API_KEY: 'gsk_from_the_caller' });
    const withKey = await app.request('/api/v1/health', { headers: { 'x-vid2context-keys': keys } });
    const text = await withKey.text();
    expect(text).not.toContain('gsk_from_the_caller');
    const body = JSON.parse(text);
    expect(body.requestKeys.accepted).toBe(true);
    expect(body.requestKeys.names).toContain('GROQ_API_KEY');
    expect(groqRung(body)?.enabled).toBe(true);

    const without = await (await app.request('/api/v1/health')).json();
    expect(groqRung(without)?.enabled).toBe(false);
  });

  it('cannot change server settings such as the API keys that guard it', async () => {
    const { app } = makeApp({ env: { VID2CONTEXT_API_KEYS: 'server-key' } });
    const res = await app.request('/api/v1/formats', {
      headers: { 'x-vid2context-keys': JSON.stringify({ VID2CONTEXT_API_KEYS: 'mine' }), authorization: 'Bearer mine' },
    });
    expect(res.status).toBe(401);
  });

  it('answers bad-request for a malformed header', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v1/formats', { headers: { 'x-vid2context-keys': 'GROQ_API_KEY=abc' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: 'bad-request', hint: expect.stringContaining('requestKeys') });
  });

  it('ignores the header when the operator turned the feature off', async () => {
    const { app } = makeApp({ env: { VID2CONTEXT_REQUEST_KEYS: '0' } });
    const res = await app.request('/api/v1/health', {
      headers: { 'x-vid2context-keys': JSON.stringify({ GROQ_API_KEY: 'gsk_from_the_caller' }) },
    });
    const body = await res.json();
    expect(body.requestKeys).toEqual({ accepted: false, names: [] });
    expect(groqRung(body)?.enabled).toBe(false);
  });

  it('parses only allowed names with printable values', () => {
    const allowed = new Set(['GROQ_API_KEY']);
    expect(parseRequestKeys(JSON.stringify({ GROQ_API_KEY: ' gsk_1 ', OTHER_API_KEY: 'x' }), allowed)).toEqual({
      GROQ_API_KEY: 'gsk_1',
    });
    expect(parseRequestKeys(JSON.stringify({ GROQ_API_KEY: '' }), allowed)).toEqual({});
    expect(() => parseRequestKeys(JSON.stringify({ GROQ_API_KEY: 'has space' }), allowed)).toThrow(/invalid value/);
    expect(() => parseRequestKeys('[]', allowed)).toThrow(/not a JSON object/);
    expect(() => parseRequestKeys(JSON.stringify({ GROQ_API_KEY: 5 }), allowed)).toThrow(/non-string/);
  });
});
