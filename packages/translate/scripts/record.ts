/**
 * Re-record the LLM fixtures for the translation tests from the real keyless
 * OVH rungs. Run from the repo root:
 *
 *   LIVE=1 node_modules/.bin/tsx packages/translate/scripts/record.ts
 *
 * Input: the first 30 segments of tests/fixtures/contexts/youtube-cCPsdFdlshc.json,
 * translated to German twice: in two chunks (`llm-de-chunks-NNN.json`) and in
 * one chunk (`llm-de-whole-NNN.json`). Scrubbed by the testkit recorder.
 * Document any change in test/fixtures/README.md.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { clearCooldowns, createContext, Registry, type VideoContext } from '@vid2context/core';
import llm from '@vid2context/provider-llm-openai-compatible';
import { recordingFetch } from '@vid2context/testkit/recorder';
import { translateContext } from '../src/index.ts';

if (!process.env.LIVE) {
  console.error('Set LIVE=1 to call the real service.');
  process.exit(1);
}

export const SAMPLE_SEGMENTS = 30;
export const SMALL_CHUNK_TOKENS = 250;

const dir = join(import.meta.dirname, '..', 'test', 'fixtures');
const full = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'contexts', 'youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;
const context: VideoContext = {
  ...full,
  transcript: { ...full.transcript, segments: full.transcript.segments.slice(0, SAMPLE_SEGMENTS) },
};

for (const [name, chunkTokens] of [
  ['llm-de-chunks', SMALL_CHUNK_TOKENS],
  ['llm-de-whole', undefined],
] as const) {
  for (let round = 1; round <= 5; round++) {
    for (let i = 1; i <= 9; i++) rmSync(join(dir, `${name}-${String(i).padStart(3, '0')}.json`), { force: true });
    clearCooldowns();
    // OVH keyless allows 2 requests per minute per model and IP.
    await new Promise((r) => setTimeout(r, 65_000));
    const fetch = recordingFetch(globalThis.fetch, { dir, name });
    const ctx = createContext({ runtime: 'node', env: {}, fetch });
    try {
      const res = await translateContext(
        new Registry([llm], 'node'),
        context,
        { language: 'de', platform: false, chunkTokens, chain: { only: ['ovh'] } },
        ctx,
      );
      console.error(`${name} round ${round}: ${res.producer}, report ${JSON.stringify(res.report)}; ${fetch.files.length} files`);
      if (res.report.failed.length === 0 && res.report.retried.length === 0) {
        for (const [i, s] of res.transcript.segments.entries())
          console.error(i, s.startSec, s.text, '|', context.transcript.segments[i]?.text);
        break;
      }
    } catch (err) {
      console.error(`${name} round ${round} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
