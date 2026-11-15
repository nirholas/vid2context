import { readFileSync } from 'node:fs';
import {
  type AudioInput,
  clearCooldowns,
  type Env,
  Registry,
  transcribe,
  Vid2ContextError,
  type VideoRef,
} from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { sttProvider as cloudflareStt } from '@vid2context/provider-cloudflare-ai';
import openaiStt from '@vid2context/provider-stt-openai-compatible';
import { beforeEach, describe, expect, it } from 'vitest';

// Real nova-3 recording of the Apollo clip, see providers/cloudflare-ai/test/fixtures/README.md.
const nova3Apollo = readFileSync(
  new URL('../../../providers/cloudflare-ai/test/fixtures/nova-3.apollo.diarize.json', import.meta.url),
  'utf8',
);
const apollo = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url)));
const audio: AudioInput = { kind: 'bytes', data: apollo, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' };
const ref: VideoRef = {
  input: 'apollo11-small-step.mp3',
  platform: 'file',
  kind: 'video',
  id: 'file:apollo11-small-step',
  nativeId: 'apollo11-small-step',
};

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const CF_ENV: Env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'cf-test-token' };
const NOVA3 = 'stt/cloudflare/@cf/deepgram/nova-3';
const RUN_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/deepgram/nova-3`;
const registry = new Registry([openaiStt, cloudflareStt], 'node');

beforeEach(() => clearCooldowns());

describe('transcribe with diarize', () => {
  it('skips rungs that cannot diarize and answers from one that can', async () => {
    const fetch = replayFetch([{ method: 'POST', url: (u) => u.href.startsWith(RUN_URL), response: { body: nova3Apollo } }]);
    const ctx = testContext({ env: CF_ENV, fetch });
    const { transcript, attempts } = await transcribe(registry, ref, audio, { stt: { diarize: true } }, ctx);

    expect(transcript.producer).toBe(NOVA3);
    expect(transcript.segments.every((s) => s.speaker === 'Speaker 0')).toBe(true);
    // Whisper rungs (keyless OVH, Cloudflare Whisper) are enabled but never tried.
    expect(attempts.filter((a) => a.stage === 'stt').map((a) => a.id)).toEqual([NOVA3]);
    expect(fetch.calls).toHaveLength(1);
  });

  it('fails with a hint naming the Cloudflare keys when no enabled rung can diarize', async () => {
    const fetch = replayFetch([]);
    const ctx = testContext({ fetch });
    const err = await transcribe(registry, ref, audio, { stt: { diarize: true } }, ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('no-provider');
    expect((err as Vid2ContextError).hint).toContain('CLOUDFLARE_API_TOKEN');
    // Nothing was uploaded to a rung that would have returned no speakers.
    expect(fetch.calls).toHaveLength(0);
  });
});
