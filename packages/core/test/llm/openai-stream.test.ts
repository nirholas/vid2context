import llmOpenAiCompatible from '@vid2context/provider-llm-openai-compatible';
import { describe, expect, it } from 'vitest';
import { Vid2ContextError } from '../../src/errors.ts';
import { streamOpenAiChat } from '../../src/llm/openai-stream.ts';
import type { ChatStreamEvent } from '../../src/llm-stream.ts';
import { canStream } from '../../src/llm-stream.ts';
import { replayFetch, testContext } from '../../src/testing.ts';
import { expected, recording, response, STREAMS } from './fixtures.ts';

const question = {
  messages: [{ role: 'user' as const, content: 'Which year did Apollo 11 land on the moon? Answer in one short sentence.' }],
  maxTokens: 300,
};

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function texts(events: ChatStreamEvent[], type: 'delta' | 'reasoning'): string[] {
  return events.flatMap((e) => (e.type === type ? [e.text] : []));
}

describe('streamOpenAiChat on real recorded streams', () => {
  for (const name of STREAMS) {
    it(`${name}: deltas make up the done text, reasoning stays separate, usage is read`, async () => {
      const rec = recording(name);
      const fetch = replayFetch([{ url: rec.url, response: response(rec) }]);
      const model = String(rec.request.model);
      const events = await collect(streamOpenAiChat({ url: rec.url, model }, question, testContext({ fetch })));
      const want = expected(rec);

      const done = events.at(-1);
      expect(done?.type).toBe('done');
      if (done?.type !== 'done') return;
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(texts(events, 'delta').join('')).toBe(done.result.text);
      expect(done.result.text).toBe(want.content.trimStart());
      expect(texts(events, 'reasoning').join('')).toBe(want.reasoning);
      // The answer is built from content fields only, so reasoning cannot have leaked into it.
      if (want.reasoning) expect(done.result.text).not.toContain(want.reasoning);
      expect(done.result.usage).toEqual({ inputTokens: want.usage?.prompt_tokens, outputTokens: want.usage?.completion_tokens });
      expect(done.result.model).toBe(model === 'openai-fast' ? 'gpt-oss-20b' : model);
    });
  }

  it('reports reasoning deltas from gpt-oss before the answer', async () => {
    const rec = recording('ovh-gpt-oss-120b.stream');
    const fetch = replayFetch([{ url: rec.url, response: response(rec) }]);
    const events = await collect(streamOpenAiChat({ url: rec.url, model: 'gpt-oss-120b' }, question, testContext({ fetch })));
    expect(events[0]?.type).toBe('reasoning');
    expect(texts(events, 'reasoning').length).toBeGreaterThan(10);
    expect(texts(events, 'delta').join('')).toContain('1969');
  });

  it('sends stream: true and stream_options, without a key on keyless lanes', async () => {
    const rec = recording('ovh-llama-3.3-70b.stream');
    const fetch = replayFetch([{ url: rec.url, response: response(rec) }]);
    await collect(streamOpenAiChat({ url: rec.url, model: 'Meta-Llama-3_3-70B-Instruct' }, question, testContext({ fetch })));
    const call = fetch.calls[0];
    expect(call?.headers.authorization).toBeUndefined();
    expect(JSON.parse(String(call?.body))).toEqual({
      model: 'Meta-Llama-3_3-70B-Instruct',
      messages: question.messages,
      max_tokens: 300,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('maps a 429 before the stream starts to rate-limited with Retry-After', async () => {
    const rec = recording('ovh-llama-3.3-70b.stream.http429');
    const fetch = replayFetch([{ url: rec.url, response: response(rec) }]);
    const run = collect(
      streamOpenAiChat({ url: rec.url, model: 'Meta-Llama-3_3-70B-Instruct', label: 'ovh' }, question, testContext({ fetch })),
    );
    await expect(run).rejects.toMatchObject({ code: 'rate-limited', status: 429, retryAfterSec: 54 });
    await expect(run).rejects.toBeInstanceOf(Vid2ContextError);
  });

  it('treats a body cut off mid-answer as an error, not a short answer', async () => {
    const rec = recording('ovh-llama-3.3-70b.stream');
    const raw = new TextDecoder().decode(rec.body);
    const cut = new TextEncoder().encode(raw.slice(0, raw.indexOf('"content":" ') + 200));
    const fetch = replayFetch([{ url: rec.url, response: response(rec, cut) }]);
    const events: ChatStreamEvent[] = [];
    const run = async () => {
      for await (const e of streamOpenAiChat({ url: rec.url, model: 'x', label: 'ovh' }, question, testContext({ fetch })))
        events.push(e);
    };
    await expect(run()).rejects.toMatchObject({ code: 'upstream' });
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});

describe('streaming on the foundation OpenAI-compatible rungs', () => {
  it('every rung streams', () => {
    const rungs = llmOpenAiCompatible.rungs({ GROQ_API_KEY: 'gsk_a', OLLAMA_MODEL: 'qwen3:8b' });
    expect(rungs.length).toBeGreaterThan(5);
    expect(rungs.every((r) => canStream(r))).toBe(true);
  });

  it('rung.stream sends the same body as chat() plus the streaming fields', async () => {
    const rec = recording('pollinations-openai-fast.stream');
    const rung = llmOpenAiCompatible.rungs({}).find((r) => r.id === 'llm/pollinations/openai-fast');
    if (!rung || !canStream(rung)) throw new Error('pollinations rung missing or not streaming');
    const fetch = replayFetch([{ url: rec.url, response: response(rec) }]);
    const req = { ...question, json: true };
    const events = await collect(rung.stream(req, testContext({ fetch })));
    expect(events.at(-1)?.type).toBe('done');
    const body = JSON.parse(String(fetch.calls[0]?.body));
    // buildBody adds json_object and the JSON instruction for json requests, as chat() does.
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});
