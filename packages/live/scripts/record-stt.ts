/**
 * Record the keyless OVH speech-to-text responses the replay tests use:
 *
 *   LIVE=1 npx tsx packages/live/scripts/record-stt.ts [scenario ...]
 *
 * Runs each scenario from test/scenarios.ts over the recorded HLS fixtures,
 * sends the real chunk audio to OVH AI Endpoints (no key) and saves the
 * responses, in order, to test/fixtures/stt/<scenario>.json. The keyless tier
 * allows about 2 requests per minute per IP, so 429s are waited out and the
 * request repeated. Needs ffmpeg.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordedCall, RecordedResponse } from '@vid2context/core/testing';
import { FIXTURES, runScenario, SCENARIOS, type SttResponder } from '../test/scenarios.ts';

if (!process.env.LIVE) throw new Error('Set LIVE=1: this script calls the real OVH endpoint.');
const KEEP_HEADERS = ['content-type', 'retry-after', 'x-ratelimit-limit-minute', 'x-ratelimit-remaining-minute'];

/**
 * Sends one chunk to OVH. The keyless quota is per IP and shared with
 * anything else on this machine, so a 429 is waited out (Retry-After) and the
 * same request is sent again; only the final answer is saved.
 */
function recorder(saved: RecordedResponse[]): SttResponder {
  return async (call: RecordedCall) => {
    for (let attempt = 1; attempt <= 30; attempt++) {
      const res = await fetch(call.url, { method: call.method, headers: call.headers, body: call.body as BodyInit });
      const body = await res.text();
      if (res.status === 429) {
        const wait = Math.max(Number(res.headers.get('retry-after')) || 30, 5) + 1;
        console.error(`  OVH 429 (attempt ${attempt}), waiting ${wait} s`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const headers: Record<string, string> = {};
      for (const h of KEEP_HEADERS) {
        const v = res.headers.get(h);
        if (v) headers[h] = v;
      }
      const rec: RecordedResponse = { status: res.status, headers, body };
      saved.push(rec);
      console.error(`  OVH ${res.status} ${body.slice(0, 200)}`);
      return rec;
    }
    throw new Error('OVH kept answering 429');
  };
}

const wanted = process.argv.slice(2);
mkdirSync(join(FIXTURES, 'stt'), { recursive: true });
for (const s of Object.values(SCENARIOS)) {
  if (wanted.length > 0 && !wanted.includes(s.name)) continue;
  console.error(`scenario ${s.name}`);
  const saved: RecordedResponse[] = [];
  const { events } = await runScenario(s, recorder(saved), { limitMs: 30 * 60_000 });
  for (const e of events)
    console.error(`  ${e.type}: ${e.type === 'segment' ? e.segment.text : e.type === 'status' ? e.message : e.reason}`);
  writeFileSync(join(FIXTURES, 'stt', `${s.name}.json`), `${JSON.stringify(saved, null, 2)}\n`);
}
