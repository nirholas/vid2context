/**
 * LLM rerank through the real llm-openai-compatible provider (keyless lanes),
 * replaying the chat response recorded from OVH, with embeddings replayed
 * from the bge-m3 fixture.
 */
import { readFileSync } from 'node:fs';
import { clearCooldowns } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSearchEngine } from '../src/engine.ts';
import { parseRerankReply } from '../src/rerank.ts';
import { embedProvider, embedRoute, GWAGON, loadContext, loadEmbedFixture, ovhEmbedRung, registryWith, ZOO } from './helpers.ts';

interface RerankFixture {
  query: string;
  rung: string;
  url: string;
  model: string;
  status: number;
  body: string;
}

const rec = JSON.parse(readFileSync(new URL('./fixtures/rerank-ovh.json', import.meta.url), 'utf8')) as RerankFixture;
const registry = registryWith([embedProvider([ovhEmbedRung()]), ...[llm].flat()]);

beforeEach(() => clearCooldowns());

/** Serves the recorded chat body only to the model it was recorded from; other rungs fail as if unreachable. */
const chatRoute = {
  method: 'POST',
  url: rec.url,
  response: (call: { body: unknown }) => {
    const model = (JSON.parse(String(call.body)) as { model: string }).model;
    if (model !== rec.model) throw new Error(`no recorded chat response for ${model}`);
    return { status: rec.status, headers: { 'content-type': 'application/json' }, body: rec.body };
  },
};

async function engineWith(routes: Parameters<typeof replayFetch>[0]) {
  const engine = createSearchEngine({ registry, ctx: testContext({ fetch: replayFetch(routes) }) });
  await engine.index(loadContext(GWAGON));
  await engine.index(loadContext(ZOO));
  return engine;
}

describe('rerank', () => {
  it('reorders the fused top candidates by the LLM score', async () => {
    const engine = await engineWith([embedRoute(loadEmbedFixture()), chatRoute]);
    const plain = await engine.search({ query: rec.query, limit: 5 });
    const out = await engine.search({ query: rec.query, limit: 5, rerank: true });
    expect(out.meta.rerank).toBe('ok');
    expect(out.meta.rerankRung).toBe(rec.rung);
    const [top] = out.hits;
    expect(top?.rerankScore).toBe(8);
    expect(top && top.startSec <= 92.6 && top.endSec >= 95).toBe(true);
    expect(top?.text).toContain('timing Chains');
    expect(plain.meta.rerank).toBe('off');
    expect(plain.hits[0]?.rerankScore).toBeUndefined();
  });

  it('parses the real reply into one score per candidate', () => {
    const content = (JSON.parse(rec.body) as { choices: { message: { content: string } }[] }).choices[0]?.message.content ?? '';
    const scores = parseRerankReply(content, 20);
    expect(scores.size).toBe(20);
    expect(scores.get(1)).toBe(8);
    expect(() => parseRerankReply(content, 0)).toThrow(/no usable scores/);
  });

  it('keeps the fused order and says why when every LLM rung fails', async () => {
    const engine = await engineWith([embedRoute(loadEmbedFixture())]);
    const plain = await engine.search({ query: rec.query, limit: 5 });
    const out = await engine.search({ query: rec.query, limit: 5, rerank: true });
    expect(out.meta.rerank).toBe('failed');
    expect(out.meta.rerankReason).toMatch(/^Kept the fused order: all-rungs-failed/);
    expect(out.meta.attempts.some((a) => a.stage === 'llm' && a.outcome === 'error')).toBe(true);
    expect(out.hits.map((h) => [h.videoId, h.startSec])).toEqual(plain.hits.map((h) => [h.videoId, h.startSec]));
  });
});
