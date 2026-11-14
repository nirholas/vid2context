/**
 * Live tests against the real services. Run with LIVE=1 and the credentials
 * for each block; blocks without credentials are skipped.
 *
 *   LIVE=1 GEMINI_API_KEY=... ANTHROPIC_API_KEY=... npx vitest run providers/llm-native/test/live.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ChatRequest,
  type ChatStreamEvent,
  type Ctx,
  createContext,
  type Env,
  type StreamingLlmRung,
} from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import type { NativeChatResult } from '../src/index.ts';
import { nativeRungs } from '../src/index.ts';

const env: Env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
const live = Boolean(process.env.LIVE);

function ctx(): Ctx {
  return createContext({
    runtime: 'node',
    env,
    fetch: globalThis.fetch,
    log: { debug() {}, info() {}, warn: console.error, error: console.error },
  });
}

const video = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'contexts', 'youtube-cCPsdFdlshc.json'), 'utf8'),
) as { metadata: { title: string }; transcript: { segments: { startSec: number; text: string }[] } };
const system = `You answer questions about one video transcript. Cite timestamps like [123s].\n\nVideo: ${video.metadata.title}\n\nTranscript:\n${video.transcript.segments
  .map((s) => `[${Math.floor(s.startSec)}s] ${s.text}`)
  .join('\n')}`;

const apollo: ChatRequest = {
  messages: [{ role: 'user', content: 'Which year did Apollo 11 land on the moon? One sentence.' }],
  maxTokens: 2000,
};
const apolloJson: ChatRequest = {
  messages: [{ role: 'user', content: 'Which year did Apollo 11 land on the moon? Use keys year and mission.' }],
  maxTokens: 2000,
  json: {
    schema: {
      type: 'object',
      properties: { year: { type: 'integer' }, mission: { type: 'string' } },
      required: ['year', 'mission'],
    },
  },
};
const ask = (q: string): ChatRequest => ({
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: q },
  ],
  maxTokens: 4000,
});

async function collect(r: StreamingLlmRung, req: ChatRequest) {
  const events: ChatStreamEvent[] = [];
  for await (const ev of r.stream(req, ctx())) events.push(ev);
  return events;
}

function suite(name: string, enabled: boolean, pick: () => StreamingLlmRung, opts: { cacheReads?: boolean } = {}) {
  describe.skipIf(!live || !enabled)(`live: ${name}`, () => {
    it('answers', async () => {
      const res = await pick().chat(apollo, ctx());
      expect(res.text).toMatch(/1969/);
    }, 120_000);

    it('streams text deltas and one final result', async () => {
      const events = await collect(pick(), ask('Which model years does the video recommend avoiding?'));
      const deltas = events.filter((e) => e.type === 'delta');
      expect(deltas.length).toBeGreaterThan(0);
      const done = events.at(-1);
      expect(done?.type).toBe('done');
      if (done?.type === 'done')
        expect(done.result.text).toBe(
          deltas
            .map((d) => (d.type === 'delta' ? d.text : ''))
            .join('')
            .trim(),
        );
    }, 180_000);

    it('returns JSON matching the schema', async () => {
      const res = await pick().chat(apolloJson, ctx());
      expect(JSON.parse(res.text)).toMatchObject({ year: 1969 });
    }, 120_000);

    if (opts.cacheReads) {
      it('reads the cached transcript on the second question', async () => {
        const r = pick();
        await r.chat(ask('Which model years does the video recommend avoiding?'), ctx());
        const second = (await r.chat(ask('What does the video say about the interior?'), ctx())) as NativeChatResult;
        expect(second.usage?.cacheReadInputTokens ?? 0).toBeGreaterThan(0);
      }, 240_000);
    }
  });
}

const first = (service: string) => () => {
  const r = nativeRungs(env).find((x) => x.service === service);
  if (!r) throw new Error(`no ${service} rung`);
  return r;
};

suite('anthropic', Boolean(env.ANTHROPIC_API_KEY), first('anthropic'), { cacheReads: true });
suite('gemini-native', Boolean(env.GEMINI_API_KEY), first('gemini-native'));
const vertex = Boolean(env.GOOGLE_CLOUD_PROJECT && (env.GOOGLE_ACCESS_TOKEN || env.VID2CONTEXT_GCE_METADATA === '1'));
suite('vertex-gemini', vertex, first('vertex-gemini'));
suite('vertex-anthropic', vertex, first('vertex-anthropic'), { cacheReads: true });
