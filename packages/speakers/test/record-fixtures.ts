/**
 * Re-records the speaker-naming fixtures from the real services. Not a test:
 * run it by hand when a fixture needs refreshing.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npx tsx packages/speakers/test/record-fixtures.ts [all|llm] [rung id]
 *
 * 1. Downloads each clip from Wikimedia Commons and converts it with ffmpeg (mono, 16 kHz, 32 kbps MP3).
 * 2. Transcribes it with Deepgram nova-3 on Cloudflare Workers AI with diarization on.
 * 3. Saves the Commons file record.
 * 4. Runs nameSpeakers on the keyless LLM rungs and saves every LLM response in order.
 *
 * `llm` skips steps 1 to 3 and only re-records the LLM answers. A rung id (for example
 * llm/ovh/Meta-Llama-3_3-70B-Instruct) runs only that rung and saves to llm-<clip>--<service>-<model>.json,
 * which is how the alternative answers used by the evidence tests were recorded.
 * Needs ffmpeg on PATH. Logs go to stderr.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCooldowns, createContext, Registry, stderrLogger } from '@vid2context/core';
import llm from '@vid2context/provider-llm-openai-compatible';
import { nameSpeakers } from '../src/index.ts';
import { CLIPS, type Clip, FIXTURES, loadContext } from './fixture-context.ts';

const UA = 'vid2context-fixture-recorder/0.1 (https://github.com/nirholas/vid2context)';
const env = process.env as Record<string, string | undefined>;

async function recordTranscript(clip: Clip): Promise<void> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|size|mime|extmetadata&format=json&titles=${encodeURIComponent(clip.commonsTitle)}`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`commons ${res.status}`);
  const body = (await res.json()) as { query: { pages: Record<string, { imageinfo: { url: string }[] }> } };
  writeFileSync(`${FIXTURES}commons-${clip.stem}.json`, `${JSON.stringify(body, null, 2)}\n`);

  const mediaUrl = Object.values(body.query.pages)[0]?.imageinfo[0]?.url;
  if (!mediaUrl) throw new Error(`no media url for ${clip.commonsTitle}`);
  const dir = mkdtempSync(join(tmpdir(), 'v2c-speakers-'));
  try {
    const src = join(dir, 'source');
    const mp3 = join(dir, 'audio.mp3');
    const media = await fetch(mediaUrl, { headers: { 'user-agent': UA } });
    if (!media.ok) throw new Error(`media ${media.status}`);
    writeFileSync(src, new Uint8Array(await media.arrayBuffer()));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', mp3]);

    const account = env.CLOUDFLARE_ACCOUNT_ID;
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!account || !token) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const q = 'diarize=true&smart_format=true&punctuate=true&utterances=true&paragraphs=true&detect_language=true';
    const stt = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/deepgram/nova-3?${q}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/mpeg' },
      body: readFileSync(mp3),
    });
    if (!stt.ok) throw new Error(`workers ai ${stt.status} ${await stt.text()}`);
    writeFileSync(`${FIXTURES}nova3-${clip.stem}.json`, `${JSON.stringify(await stt.json(), null, 2)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.error(`recorded commons and nova-3 for ${clip.stem}`);
}

export interface RecordedLlmCall {
  url: string;
  method: string;
  status: number;
  contentType: string;
  body: string;
}

/** Keyless hosts allow a reply every minute or so per IP; wait and try again when every rung was rate-limited. */
async function recordNaming(clip: Clip, only?: string): Promise<void> {
  for (let tryNo = 1; ; tryNo++) {
    try {
      return await recordNamingOnce(clip, only);
    } catch (err) {
      if ((err as { code?: string }).code !== 'all-rungs-failed' || tryNo >= 8) throw err;
      clearCooldowns();
      console.error(`every keyless rung was busy, waiting 70 s (try ${tryNo})`);
      await new Promise((r) => setTimeout(r, 70_000));
    }
  }
}

async function recordNamingOnce(clip: Clip, only?: string): Promise<void> {
  const calls: RecordedLlmCall[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const body = await res.text();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const contentType = res.headers.get('content-type') ?? '';
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), status: res.status, contentType, body });
    return new Response(body, { status: res.status, headers: { 'content-type': contentType } });
  };
  // An empty env leaves the keyless lanes as the only enabled rungs.
  const ctx = createContext({ runtime: 'node', env: {}, fetch: recordingFetch, log: stderrLogger('debug') });
  const registry = new Registry([llm].flat(), 'node');
  const result = await nameSpeakers(loadContext(clip), registry, ctx, only ? { chain: { only: [only] } } : {});
  const out = { recordedAt: new Date().toISOString(), rung: result.rung, calls };
  const suffix = only ? `--${only.replace(/^llm\//, '').replace(/[^A-Za-z0-9.]+/g, '-')}` : '';
  writeFileSync(`${FIXTURES}llm-${clip.stem}${suffix}.json`, `${JSON.stringify(out, null, 2)}\n`);
  console.error(`recorded ${calls.length} llm call(s) for ${clip.stem} via ${result.rung}`);
  console.error(JSON.stringify(result.mapping, null, 2));
}

const what = process.argv[2] ?? 'all';
const only = process.argv[3];
for (const clip of only ? [CLIPS.call] : Object.values(CLIPS)) {
  if (what === 'all') await recordTranscript(clip);
  await recordNaming(clip, only);
}
