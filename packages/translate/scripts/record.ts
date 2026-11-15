/**
 * Re-record the LLM fixtures for the translation tests from the real keyless
 * OVH rungs. Run from the repo root:
 *
 *   LIVE=1 node_modules/.bin/tsx packages/translate/scripts/record.ts [fixture name]
 *
 * With a fixture name (`llm-de-chunks`, `llm-de-whole` or `llm-fr-echo`), only
 * that set is re-recorded.
 *
 * Input: the first 30 segments of tests/fixtures/contexts/youtube-cCPsdFdlshc.json,
 * translated to German twice: in two chunks (`llm-de-chunks-NNN.json`) and in
 * one chunk (`llm-de-whole-NNN.json`).
 *
 * Then "Me at the zoo" (tests/fixtures/contexts/youtube-jNQXAC9IVRw.json) to
 * French on the keyless Kilo lane (`llm-fr-echo-NNN.json`), kept only when the
 * first rung answers with the English text unchanged and the next rung
 * translates: the real echo case the untranslated check guards against.
 *
 * Scrubbed by the testkit recorder. Document any change in test/fixtures/README.md.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { clearCooldowns, createContext, Registry, type VideoContext } from '@vid2context/core';
import freeCatalog from '@vid2context/provider-llm-free-catalog';
import llm from '@vid2context/provider-llm-openai-compatible';
import { recordingFetch } from '@vid2context/testkit/recorder';
import { translateContext } from '../src/index.ts';

if (!process.env.LIVE) {
  console.error('Set LIVE=1 to call the real service.');
  process.exit(1);
}

const only = process.argv[2];
const wanted = (name: string): boolean => !only || only === name;

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
  if (!wanted(name)) continue;
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

const zoo = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'contexts', 'youtube-jNQXAC9IVRw.json'), 'utf8'),
) as VideoContext;
const echoName = 'llm-fr-echo';
for (let round = 1; wanted(echoName) && round <= 5; round++) {
  for (let i = 1; i <= 9; i++) rmSync(join(dir, `${echoName}-${String(i).padStart(3, '0')}.json`), { force: true });
  clearCooldowns();
  const fetch = recordingFetch(globalThis.fetch, { dir, name: echoName });
  const ctx = createContext({ runtime: 'node', env: {}, fetch });
  try {
    const res = await translateContext(
      new Registry([freeCatalog], 'node'),
      zoo,
      { language: 'fr', platform: false, chain: { only: ['kilo'] } },
      ctx,
    );
    const echoed = res.attempts.some((a) => a.reason === 'untranslated');
    console.error(`${echoName} round ${round}: ${res.producer}, echo ${echoed}, report ${JSON.stringify(res.report)}`);
    if (echoed && res.report.failed.length === 0) {
      for (const [i, s] of res.transcript.segments.entries())
        console.error(i, s.startSec, s.text, '|', zoo.transcript.segments[i]?.text);
      break;
    }
  } catch (err) {
    console.error(`${echoName} round ${round} failed:`, err instanceof Error ? err.message : err);
  }
}
