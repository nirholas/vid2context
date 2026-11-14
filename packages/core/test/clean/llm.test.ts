import llm from '@vid2context/provider-llm-openai-compatible';
import { describe, expect, it } from 'vitest';
import {
  alignPunctuatedWords,
  PUNCTUATION_SYSTEM_PROMPT,
  planPunctuationChunks,
  punctuateWithLlm,
} from '../../src/clean/index.ts';
import { Registry, type Transcript, Vid2ContextError } from '../../src/index.ts';
import { replayFetch, testContext } from '../../src/testing.ts';
import { bareWords, context, deepFreeze, fixture } from './helpers.ts';

const OVH_CHAT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';

// The recorded requests sent the first 16 segments (117 words) of the real cCPsdFdlshc auto-captions.
const full = context('youtube-cCPsdFdlshc.json').transcript;
const transcript: Transcript = deepFreeze({ ...full, segments: full.segments.slice(0, 16) });
const words = transcript.segments.flatMap((s) => s.text.split(/\s+/).filter(Boolean));

function answer(name: string): string {
  return (JSON.parse(fixture(name)) as { choices: { message: { content: string } }[] }).choices[0]?.message.content ?? '';
}

function ctxFor(name: string) {
  const fetch = replayFetch([{ method: 'POST', url: OVH_CHAT, response: { body: fixture(name) } }]);
  return { fetch, ctx: testContext({ fetch }) };
}

describe('alignPunctuatedWords', () => {
  it('accepts the real gpt-oss-120b answer, which only added punctuation and capitals', () => {
    const aligned = alignPunctuatedWords(words, answer('ovh-gpt-oss-120b.punctuate.json'));
    expect(aligned).not.toBeNull();
    expect(aligned).toHaveLength(words.length);
    expect(aligned?.[0]).toBe('So');
  });

  it('rejects the real Llama 3.3 answer, which slipped in a word ("buy a G wagon")', () => {
    const text = answer('ovh-llama-3.3-70b.punctuate-added-word.json');
    expect(text).toContain('buy a G wagon');
    expect(alignPunctuatedWords(words, text)).toBeNull();
  });
});

describe('planPunctuationChunks', () => {
  it('cuts the real 3895-word transcript into 1500-word chunks with 8 words of lead-in', () => {
    const n = full.segments.flatMap((s) => s.text.split(/\s+/).filter(Boolean)).length;
    expect(n).toBe(3895);
    expect(planPunctuationChunks(n)).toEqual([
      { from: 0, start: 0, end: 1500 },
      { from: 1492, start: 1500, end: 3000 },
      { from: 2992, start: 3000, end: 3895 },
    ]);
  });
});

describe('punctuateWithLlm (recorded OVH responses)', () => {
  it('applies a verified answer, keeps segment timings, and sends the punctuation-only instruction', async () => {
    const { fetch, ctx } = ctxFor('ovh-gpt-oss-120b.punctuate.json');
    const res = await punctuateWithLlm(transcript, new Registry([llm], 'node'), ctx);
    expect(res.report.llm).toMatchObject({ chunks: 1, accepted: 1, rejected: 0, failed: 0 });
    expect(res.report.llm?.rungs[0]).toMatch(/^llm\/ovh\//);
    expect(bareWords(res.transcript.segments)).toEqual(bareWords(transcript.segments));
    expect(res.transcript.segments.map((s) => [s.startSec, s.endSec])).toEqual(
      transcript.segments.map((s) => [s.startSec, s.endSec]),
    );
    expect(res.transcript.segments[0]?.text).toBe("So you're going to buy G wagon, which");
    expect(res.transcript.origin).toBe('auto-captions');
    const body = JSON.parse(String(fetch.calls[0]?.body)) as { messages: { role: string; content: string }[] };
    expect(body.messages).toEqual([
      { role: 'system', content: PUNCTUATION_SYSTEM_PROMPT },
      { role: 'user', content: words.join(' ') },
    ]);
  });

  it('keeps the original text when the answer changed a word, and counts the rejection', async () => {
    const { ctx } = ctxFor('ovh-llama-3.3-70b.punctuate-added-word.json');
    const res = await punctuateWithLlm(transcript, new Registry([llm], 'node'), ctx);
    expect(res.report.llm).toMatchObject({ chunks: 1, accepted: 0, rejected: 1 });
    expect(res.transcript.segments).toEqual(transcript.segments);
    expect(res.report.examples[0]?.rule).toBe('llm-rejected');
  });

  it('fails with no-provider and a hint when no LLM rung is installed', async () => {
    const err = await punctuateWithLlm(transcript, new Registry([], 'node'), testContext()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('no-provider');
    expect((err as Vid2ContextError).hint).toBeTruthy();
  });
});
