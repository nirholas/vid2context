import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { createRegistry } from '@vid2context/registry/node';
import { describe, expect, it } from 'vitest';
import { run } from '../src/main.ts';

// Real recordings shared from the provider packages and tests/fixtures.
const root = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const APOLLO = join(root, 'tests/fixtures/media/apollo11-small-step.mp3');

const fetch = replayFetch([
  {
    method: 'POST',
    url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    response: (call) => {
      const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
      const name = videoId === 'jNQXAC9IVRw' ? videoId : 'unavailable';
      return { body: read(`providers/youtube/test/fixtures/player-${name}.json`) };
    },
  },
  {
    url: /timedtext\?v=jNQXAC9IVRw.*lang=en/,
    response: { body: read('providers/youtube/test/fixtures/timedtext-jNQXAC9IVRw-en.srv3.xml') },
  },
  {
    url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions',
    response: { body: read('providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json') },
  },
]);

async function cli(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await run(
    argv,
    {
      registry: createRegistry(),
      ctx: testContext({ fetch }),
      io: { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) },
    },
    '0.1.0',
  );
  return { code, stdout, stderr };
}

describe('vid2context CLI', () => {
  it('prints a timestamped YouTube transcript', async () => {
    const res = await cli('https://youtu.be/jNQXAC9IVRw', '--timestamps');
    expect(res.code).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe('[0:01] All right, so here we are, in front of the elephants');
  });

  it('transcribes a local file through the keyless speech-to-text rung', async () => {
    const res = await cli(APOLLO, '--format', 'json');
    expect(res.code).toBe(0);
    const ctx = JSON.parse(res.stdout);
    expect(ctx.transcript).toMatchObject({ origin: 'stt', producer: 'stt/ovh/whisper-large-v3-turbo', language: 'en' });
    expect(ctx.metadata.title).toBe('apollo11-small-step');
  });

  it('prints the error hint and attempts on failure, and usage errors with exit code 2', async () => {
    const res = await cli('xxxxxxxxxxx');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('error (not-found)');
    expect(res.stderr).toContain('hint: Check the video id or URL');
    expect(res.stderr).toContain('metadata error   youtube');
    expect((await cli('jNQXAC9IVRw', '--format', 'pdf')).code).toBe(2);
    expect((await cli()).code).toBe(2);
  });
});
