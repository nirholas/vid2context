/**
 * Re-record the OVH keyless Whisper responses the longform tests replay.
 *
 *   npx tsx packages/core/test/longform/record-ovh.ts
 *
 * It runs the real long-audio orchestrator on doubleday-ch00.mp3 (4 chunks of
 * about 70 s, concurrency 1, waiting through OVH's 2 requests per minute) and
 * then sends the whole file once as a single-pass baseline. Each 200 response
 * body is written to packages/core/test/fixtures/longform/ovh-<upload name>.json.
 * Nothing personal is in these bodies (OVH echoes no IP or account data).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createContext, MemoryKv, Registry, stderrLogger, transcribeLong } from '@vid2context/core';
import sttProvider from '@vid2context/provider-stt-openai-compatible';

const dir = new URL('../fixtures/longform/', import.meta.url);
const data = new Uint8Array(readFileSync(new URL('doubleday-ch00.mp3', dir)));

const recording: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const body = init?.body;
  if (res.ok && body instanceof FormData) {
    const file = body.get('file');
    if (file instanceof File) {
      const text = await res.clone().text();
      writeFileSync(new URL(`ovh-${file.name.replace(/\.[^.]+$/, '')}.json`, dir), `${text.trim()}\n`);
      console.error(`recorded ${file.name}`);
    }
  }
  return res;
};

const ctx = createContext({ runtime: 'node', env: { VID2CONTEXT_POLICY: 'free' }, fetch: recording, log: stderrLogger('info') });
const registry = new Registry([sttProvider], 'node');
const ref = { input: 'doubleday-ch00.mp3', platform: 'file', kind: 'video' as const, id: 'file:doubleday-ch00', nativeId: 'doubleday-ch00' };
const audio = { kind: 'bytes' as const, data, mimeType: 'audio/mpeg', filename: 'doubleday-ch00.mp3' };

const started = Date.now();
const res = await transcribeLong(
  registry,
  ref,
  audio,
  { targetSec: 75, concurrency: 1, kv: new MemoryKv(), chain: { only: ['ovh'] } },
  ctx,
);
console.error(`longform: ${res.chunks} chunks, ${res.transcript.segments.length} segments, ${Date.now() - started} ms`);
console.error(JSON.stringify(res.seams));

// Single-pass baseline, after the rate-limit window clears.
await new Promise((r) => setTimeout(r, 65_000));
const [ovh] = registry.sttRungs(ctx.env).filter((r) => r.service === 'ovh');
if (!ovh) throw new Error('OVH rung missing');
await ovh.transcribe({ ...audio, filename: 'doubleday-ch00-full.mp3' }, {}, ctx);
