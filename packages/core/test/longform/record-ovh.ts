/**
 * Re-record the OVH keyless Whisper responses the longform tests replay.
 *
 *   npx tsx packages/core/test/longform/record-ovh.ts
 *
 * Run it from a network you are happy to have OVH see; it makes about seven
 * requests and waits through OVH's 2 requests per minute, so it takes a few
 * minutes. Each response body is written to
 * packages/core/test/fixtures/longform/ovh-<upload name>.json (with the status
 * before .json when it is not 200). OVH echoes no IP or account data.
 */
import { writeFileSync } from 'node:fs';
import { createContext, MemoryKv, Registry, stderrLogger, transcribeLong } from '@vid2context/core';
import sttProvider from '@vid2context/provider-stt-openai-compatible';
import { doubleday58, fileRef, fixtureBytes, fixtureDir } from './helpers.ts';

const recording: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const body = init?.body;
  if (res.status !== 429 && body instanceof FormData) {
    const file = body.get('file');
    if (file instanceof File) {
      const text = await res.clone().text();
      const name = `ovh-${file.name.replace(/\.[^.]+$/, '')}${res.ok ? '' : `.${res.status}`}.json`;
      writeFileSync(new URL(name, fixtureDir), `${text.trim()}\n`);
      console.error(`recorded ${name}`);
    }
  }
  return res;
};

const ctx = createContext({ runtime: 'node', env: {}, fetch: recording, log: stderrLogger('info') });
const registry = new Registry([sttProvider], 'node');
const chain = { only: ['ovh'] };

// 1. Stitching: 58 s split into 3 chunks of about 21 s.
const short = { kind: 'bytes' as const, data: doubleday58(), mimeType: 'audio/mpeg', filename: 'doubleday-ch00-58s.mp3' };
let t = Date.now();
const a = await transcribeLong(registry, fileRef('doubleday-ch00-58s'), short, { targetSec: 22, concurrency: 1, kv: new MemoryKv(), chain }, ctx);
console.error(`58s: ${a.chunks} chunks in ${Date.now() - t} ms`, JSON.stringify(a.seams));

// 2. Single-pass baseline of the same 58 s.
const [ovh] = registry.sttRungs(ctx.env).filter((r) => r.service === 'ovh');
if (!ovh) throw new Error('OVH rung missing');
await new Promise((r) => setTimeout(r, 61_000));
await ovh.transcribe(short, {}, ctx);

// 3. Duration cap: 90 s in one chunk, refused with 413, re-split into pieces under 60 s.
const long = { kind: 'bytes' as const, data: fixtureBytes('doubleday-ch00-90s.mp3'), mimeType: 'audio/mpeg', filename: 'doubleday-ch00-90s.mp3' };
await new Promise((r) => setTimeout(r, 61_000));
t = Date.now();
const b = await transcribeLong(registry, fileRef('doubleday-ch00-90s'), long, { concurrency: 1, kv: new MemoryKv(), chain }, ctx);
console.error(`90s: ${b.chunks} chunks in ${Date.now() - t} ms`);
for (const at of b.attempts) console.error(JSON.stringify(at));
