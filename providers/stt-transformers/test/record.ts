/**
 * Records real Transformers.js pipeline output into test/fixtures/ for the
 * mapping unit tests. Downloads the model on first run (network), then runs
 * fully offline. Usage:
 *
 *   npx tsx providers/stt-transformers/test/record.ts [model]
 *
 * Writes <model-name>.apollo.json (the 24 s shared clip) and
 * <model-name>.apollo-x3.json (the clip played three times in a row, about
 * 72 s, so the 30 s chunk windows and their offsets are exercised).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext } from '@vid2context/core';
import { DEFAULT_MODEL, decodeWithFfmpeg, nodeHooks, resolveModelId, transcribeSamples } from '../src/node.ts';

const model = resolveModelId(process.argv[2] ?? DEFAULT_MODEL);
const clip = fileURLToPath(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url));
const ctx = createContext({ runtime: 'node', env: process.env });

function concatThree(): Uint8Array {
  const r = spawnSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-stream_loop', '2', '-i', clip, '-f', 'wav', 'pipe:1'],
    { maxBuffer: 1 << 28 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return new Uint8Array(r.stdout);
}

const inputs: [string, Uint8Array, string][] = [
  ['apollo', new Uint8Array(readFileSync(clip)), 'audio/mpeg'],
  ['apollo-x3', concatThree(), 'audio/wav'],
];

for (const [name, data, mimeType] of inputs) {
  const samples = await decodeWithFfmpeg({ kind: 'bytes', data, mimeType, filename: `${name}` }, ctx);
  const started = Date.now();
  const result = await transcribeSamples(nodeHooks, model, samples, {}, ctx);
  const file = fileURLToPath(new URL(`./fixtures/${model.split('/').pop()}.${name}.json`, import.meta.url));
  const record = {
    recordedAt: new Date().toISOString().slice(0, 10),
    model,
    device: result.device,
    runtime: 'node',
    input: name,
    durationSec: samples.length / 16000,
    detectedLanguage: result.language,
    ms: Date.now() - started,
    output: result.raw,
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.error(`wrote ${file}: ${result.segments.length} segments in ${record.ms} ms`);
}
