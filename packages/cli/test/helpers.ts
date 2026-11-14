/**
 * Shared test setup: a registry built from the finished providers the tests
 * need, a replayFetch serving real recordings, and a `cli()` runner that
 * captures stdout and stderr separately.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Env, Registry, type Storage } from '@vid2context/core';
import { type ReplayFetch, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import mediaFile from '@vid2context/provider-media-file';
import sttOpenAiCompatible from '@vid2context/provider-stt-openai-compatible';
import youtube from '@vid2context/provider-youtube';
import type { Exec } from '../src/exec.ts';
import { run } from '../src/main.ts';

export const ROOT = join(import.meta.dirname, '../../..');
export const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
export const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
export const APOLLO = join(ROOT, 'tests/fixtures/media/apollo11-small-step.mp3');
const YT = 'providers/youtube/test/fixtures';
const json = (body: string) => ({ body, headers: { 'content-type': 'application/json' } });

export function registry(): Registry {
  return new Registry([youtube, mediaFile, sttOpenAiCompatible].flat(), 'node');
}

interface RecordedBrowse {
  url: string;
  body: Record<string, unknown>;
  status: number;
  response: unknown;
}

/** Real recordings: YouTube player and caption tracks, the OVH Whisper answer, the playlist browse call, the OVH models list. */
export function routes(extra: Route[] = []): Route[] {
  const browse = JSON.parse(fixture('playlist-gwagon.json')) as RecordedBrowse[];
  return [
    ...extra,
    {
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      response: (call) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        const name = ['jNQXAC9IVRw', 'cCPsdFdlshc'].includes(videoId) ? videoId : 'unavailable';
        return json(read(`${YT}/player-${name}.json`));
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/, response: { body: read(`${YT}/timedtext-jNQXAC9IVRw-en.srv3.xml`) } },
    {
      url: /timedtext\?v=cCPsdFdlshc.*lang=en.*fmt=srv3/,
      response: { body: read(`${YT}/timedtext-cCPsdFdlshc-en-asr.srv3.xml`) },
    },
    {
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false',
      response: (call) => {
        const { context: _c, ...body } = JSON.parse(String(call.body)) as Record<string, unknown>;
        const hit = browse.find((b) => JSON.stringify(b.body) === JSON.stringify(body));
        if (!hit) throw new Error(`no recorded browse response for ${JSON.stringify(body)}`);
        return { status: hit.status, ...json(JSON.stringify(hit.response)) };
      },
    },
    {
      url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions',
      response: json(read('providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json')),
    },
    { url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models', response: json(fixture('ovh-models.json')) },
  ];
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  fetch: ReplayFetch;
}

export async function cli(
  argv: string[],
  opts: { env?: Env; storage?: Storage; fetch?: ReplayFetch; cwd?: string; exec?: Exec } = {},
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const fetch = opts.fetch ?? replayFetch(routes());
  const code = await run(
    argv,
    {
      registry: registry(),
      ctx: testContext({ fetch, env: opts.env ?? {} }),
      io: { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) },
      storage: opts.storage,
      cwd: opts.cwd,
      exec: opts.exec,
    },
    '0.1.0',
  );
  return { code, stdout, stderr, fetch };
}
