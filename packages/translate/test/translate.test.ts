import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearCooldowns, getVideoContext, Registry, type VideoContext } from '@vid2context/core';
import { type RecordedCall, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import freeCatalog from '@vid2context/provider-llm-free-catalog';
import llm from '@vid2context/provider-llm-openai-compatible';
import { youtubeCaptions, youtubeSource } from '@vid2context/provider-youtube';
import { type RecordedExchange, readRecorded } from '@vid2context/testkit/recorder';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildGlossary,
  chunkItems,
  chunkRequest,
  languageName,
  parseItems,
  sameLanguage,
  translateContext,
  unchangedIds,
  verifyItems,
} from '../src/index.ts';

// Real data only: shared VideoContext fixtures, YouTube responses recorded by
// the youtube provider, and OVH answers recorded by scripts/record.ts (the
// first 30 segments of the G-Wagon video, translated to German).
const root = join(import.meta.dirname, '..', '..', '..');
const fixtures = join(import.meta.dirname, 'fixtures');
const loadContext = (id: string): VideoContext =>
  JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'contexts', `youtube-${id}.json`), 'utf8')) as VideoContext;
const yt = (name: string) => readFileSync(join(root, 'providers', 'youtube', 'test', 'fixtures', name), 'utf8');

const full = loadContext('cCPsdFdlshc');
const gwagon30: VideoContext = { ...full, transcript: { ...full.transcript, segments: full.transcript.segments.slice(0, 30) } };
const zoo = loadContext('jNQXAC9IVRw');

const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const recorded = (name: string): RecordedExchange[] => readRecorded(fixtures, { name }).map((r) => r.exchange);
const [chunk1, chunk2, chunk3] = recorded('llm-de-chunks');
const [whole] = recorded('llm-de-whole');
// "Me at the zoo" to French on Kilo keyless: the first rung echoed the English, the next one translated.
const [echoAnswer, frAnswer] = recorded('llm-fr-echo');
const KILO = 'https://api.kilo.ai/api/gateway/chat/completions';
const answerItems = (ex: RecordedExchange | undefined): unknown[] | null => {
  const body = JSON.parse(String(ex?.response.body)) as { choices: { message: { content: string } }[] };
  return parseItems(body.choices[0]?.message.content ?? '');
};
const zooItems = () => zoo.transcript.segments.map((s, id) => ({ id, text: s.text }));

/** Serve recorded OVH answers in exactly this order; any extra call fails the test. */
function ovhQueue(answers: (RecordedExchange | undefined)[]): Route {
  let i = 0;
  return {
    method: 'POST',
    url: OVH,
    response: () => {
      const ex = answers[i++];
      if (!ex) throw new Error('unexpected extra LLM call');
      return { status: ex.response.status, headers: { 'content-type': 'application/json' }, body: ex.response.body };
    },
  };
}

function youtubeRoutes(): Route[] {
  return [
    {
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        return { body: yt(`player-${videoId}.json`), headers: { 'content-type': 'application/json' } };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=de.*fmt=srv3/, response: { body: yt('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
    { url: /timedtext\?v=cCPsdFdlshc.*tlang=de/, response: { status: 429, body: yt('timedtext-429-blocked.html') } },
  ];
}

const llmOnly = new Registry([llm], 'node');
const withYouTube = new Registry([youtubeSource, youtubeCaptions, llm], 'node');
const CHAIN = { only: ['ovh'] };
const llmCalls = (fetch: { calls: RecordedCall[] }) => fetch.calls.filter((c) => c.url === OVH);

function assertTimingsKept(out: VideoContext['transcript'], src: VideoContext['transcript']) {
  expect(out.segments).toHaveLength(src.segments.length);
  out.segments.forEach((s, i) => {
    expect(s.startSec).toBe(src.segments[i]?.startSec);
    expect(s.endSec).toBe(src.segments[i]?.endSec);
    expect(s.speaker).toBe(src.segments[i]?.speaker);
  });
}

beforeEach(() => clearCooldowns());

describe('helpers', () => {
  it('builds the glossary from caller terms, the channel and repeated capitalized terms', () => {
    expect(buildGlossary(full.metadata, ['W463'])).toEqual(['W463', 'Alliance Motorworks', 'G-Wagon', 'Joe']);
    expect(buildGlossary(full.metadata, ['g wagon'])[0]).toBe('g wagon');
    expect(buildGlossary(full.metadata, ['g wagon'])).not.toContain('G-Wagon');
  });

  it('compares and names languages', () => {
    expect(sameLanguage('en', 'en-US')).toBe(true);
    expect(sameLanguage('pt-BR', 'pt-PT')).toBe(false);
    expect(sameLanguage('de', 'en')).toBe(false);
    expect(languageName('de')).toBe('German');
  });

  it('verifies ids and counts, with a sentence the model can act on', () => {
    const items = gwagon30.transcript.segments.map((s, id) => ({ id, text: s.text }));
    const answer = JSON.parse(JSON.parse(chunk1?.response.body ?? '{}').choices[0].message.content) as unknown;
    const ok = verifyItems(parseItems(JSON.stringify(answer)), items.slice(0, 12));
    expect('texts' in ok && ok.texts.size).toBe(12);
    const bad = verifyItems(parseItems(JSON.stringify(answer)), items);
    expect('problem' in bad && bad.problem).toBe(
      'Expected 30 segments, got 12. Missing ids: 12, 13, 14, 15, 16, 17, 18, 19 and 10 more.',
    );
  });
});

describe('untranslated answers', () => {
  it('flags the real echoed answer and accepts the real French one', () => {
    const echoed = verifyItems(answerItems(echoAnswer), zooItems());
    expect(echoed).toMatchObject({ unchanged: true, problem: expect.stringContaining('(5 of 5) came back unchanged') });
    const fr = verifyItems(answerItems(frAnswer), zooItems());
    expect('texts' in fr && fr.texts.get(2)).toBe('vraiment vraiment de longues trompes');
  });

  it('does not judge chunks with fewer than three sentence-like segments', () => {
    // "and that's cool" and the sound tag stay as they are: too little to call an echo.
    const short = zooItems().slice(3, 5);
    expect(unchangedIds(short, new Map(short.map((it) => [it.id, it.text])))).toBeNull();
  });
});

describe('translateContext', () => {
  it('returns the source when it is already in the language', async () => {
    const res = await translateContext(llmOnly, gwagon30, { language: 'en-US' }, testContext());
    expect(res.via).toBe('source');
    expect(res.transcript).toBe(gwagon30.transcript);
  });

  it('uses the platform track first (the creator de track of "Me at the zoo"), with no LLM call', async () => {
    const fetch = replayFetch([...youtubeRoutes(), ovhQueue([])]);
    const res = await translateContext(withYouTube, zoo, { language: 'de', chain: CHAIN }, testContext({ fetch }));
    expect(res.via).toBe('platform');
    expect(res.producer).toBe(youtubeCaptions.id);
    expect(res.transcript.language).toBe('de');
    expect(res.transcript.segments.length).toBeGreaterThan(0);
    expect(llmCalls(fetch)).toHaveLength(0);
    expect(zoo.transcript.language).toBe('en');
  });

  it('falls back to the LLM when YouTube blocks its translation, keeping every timestamp', async () => {
    const before = structuredClone(gwagon30);
    const fetch = replayFetch([...youtubeRoutes(), ovhQueue([whole])]);
    const res = await translateContext(withYouTube, gwagon30, { language: 'de', chain: CHAIN }, testContext({ fetch }));
    expect(res.attempts.some((a) => a.stage === 'captions' && a.outcome === 'error')).toBe(true);
    expect(res.via).toBe('llm');
    expect(res.transcript).toMatchObject({ language: 'de', translated: true, origin: 'auto-captions', model: 'gpt-oss-120b' });
    expect(res.producer).toBe('llm/ovh/Meta-Llama-3_3-70B-Instruct');
    assertTimingsKept(res.transcript, gwagon30.transcript);
    expect(res.transcript.segments[13]?.text).toBe('ist der G-Wagon-Spezialist und hilft mir');
    expect(res.report).toEqual({ chunks: 1, retried: [], failed: [], untranslatedSegments: 0 });
    expect(gwagon30).toEqual(before);
    expect(res.transcript).not.toBe(gwagon30.transcript);
  });

  it('sends the prompt the fixtures were recorded with', async () => {
    const fetch = replayFetch([ovhQueue([whole])]);
    await translateContext(llmOnly, gwagon30, { language: 'de', platform: false, chain: CHAIN }, testContext({ fetch }));
    const sent = JSON.parse(String(llmCalls(fetch)[0]?.body)) as { messages: { content: string }[] };
    const rec = JSON.parse(whole?.request.body ?? '{}') as { messages: { content: string }[] };
    const unfence = (s: string) => s.replace(/[0-9a-f]{24}/g, 'B');
    expect(sent.messages.map((m) => unfence(m.content))).toEqual(rec.messages.map((m) => unfence(m.content)));
    const items = gwagon30.transcript.segments.map((s, id) => ({ id, text: s.text }));
    expect(chunkItems(items, 250)).toHaveLength(3);
    expect(chunkRequest({ chunk: items, target: 'de', glossary: [] }).json).toBe(true);
  });

  it('translates chunk by chunk with the same ids', async () => {
    const fetch = replayFetch([ovhQueue([chunk1, chunk2, chunk3])]);
    const res = await translateContext(
      llmOnly,
      gwagon30,
      { language: 'de', platform: false, chunkTokens: 250, chain: CHAIN },
      testContext({ fetch }),
    );
    expect(llmCalls(fetch)).toHaveLength(3);
    expect(res.report).toEqual({ chunks: 3, retried: [], failed: [], untranslatedSegments: 0 });
    assertTimingsKept(res.transcript, gwagon30.transcript);
    for (const [i, s] of res.transcript.segments.entries()) expect(s.text).not.toBe(gwagon30.transcript.segments[i]?.text);
  });

  it('retries a chunk exactly once when the answer is missing ids', async () => {
    // The recorded answer for ids 0 to 11 is served for the request covering ids 0 to 29.
    const fetch = replayFetch([ovhQueue([chunk1, whole])]);
    const res = await translateContext(
      llmOnly,
      gwagon30,
      { language: 'de', platform: false, chain: CHAIN },
      testContext({ fetch }),
    );
    const calls = llmCalls(fetch);
    expect(calls).toHaveLength(2);
    const retry = JSON.parse(String(calls[1]?.body)) as { messages: { role: string; content: string }[] };
    expect(retry.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(retry.messages[3]?.content).toContain('Missing ids: 12, 13');
    expect(res.report).toEqual({ chunks: 1, retried: [0], failed: [], untranslatedSegments: 0 });
    expect(res.attempts.filter((a) => a.reason === 'bad-segments')).toHaveLength(1);
    assertTimingsKept(res.transcript, gwagon30.transcript);
  });

  it('keeps the original text of a chunk that fails twice and reports it', async () => {
    const fetch = replayFetch([ovhQueue([chunk1, chunk2, chunk1, chunk1])]);
    const res = await translateContext(
      llmOnly,
      gwagon30,
      { language: 'de', platform: false, chunkTokens: 250, chain: CHAIN },
      testContext({ fetch }),
    );
    expect(llmCalls(fetch)).toHaveLength(4);
    expect(res.report.retried).toEqual([2]);
    expect(res.report.failed).toEqual([
      { chunk: 2, firstId: 24, lastId: 29, reason: expect.stringContaining('Missing ids: 24') },
    ]);
    expect(res.report.untranslatedSegments).toBe(6);
    for (let i = 24; i < 30; i++) expect(res.transcript.segments[i]?.text).toBe(gwagon30.transcript.segments[i]?.text);
    expect(res.transcript.segments[0]?.text).not.toBe(gwagon30.transcript.segments[0]?.text);
    expect(res.notes[0]).toContain('6 of 30 segments kept their original text');
  });

  it('moves to the next rung when one returns the segments untranslated, with exactly one retry', async () => {
    const before = JSON.stringify(zoo);
    const byModel: Route = {
      method: 'POST',
      url: KILO,
      response: (call: RecordedCall) => {
        const { model } = JSON.parse(String(call.body)) as { model: string };
        const ex = [echoAnswer, frAnswer].find((e) => JSON.parse(String(e?.request.body)).model === model);
        if (!ex) throw new Error(`no recorded answer for ${model}`);
        return { status: ex.response.status, headers: { 'content-type': 'application/json' }, body: ex.response.body };
      },
    };
    const fetch = replayFetch([byModel]);
    const res = await translateContext(
      new Registry([freeCatalog], 'node'),
      zoo,
      { language: 'fr', platform: false, chain: { only: ['kilo'] } },
      testContext({ fetch }),
    );
    const bodies = fetch.calls
      .filter((c) => c.url === KILO)
      .map((c) => JSON.parse(String(c.body)) as { model: string; messages: { role: string }[] });
    expect(bodies.map((b) => b.model)).toEqual(['nvidia/nemotron-3.5-lightning:free', 'nvidia/nemotron-3-ultra-550b-a55b:free']);
    // The retry is the first request again, sent to the next rung: feedback does not fix a rung that echoes.
    expect(bodies[1]?.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(res.report).toEqual({ chunks: 1, retried: [0], failed: [], untranslatedSegments: 0 });
    expect(res.attempts.filter((a) => a.reason === 'untranslated').map((a) => a.id)).toEqual([
      'llm/kilo/nvidia/nemotron-3.5-lightning:free',
    ]);
    expect(res.producer).toBe('llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(res.transcript.segments[0]?.text).toBe('Très bien, nous voici devant les éléphants');
    assertTimingsKept(res.transcript, zoo.transcript);
    expect(JSON.stringify(zoo)).toBe(before);
  });

  it('fails clearly when no rung can translate, and on a bad language code', async () => {
    await expect(
      translateContext(
        llmOnly,
        gwagon30,
        { language: 'de', platform: false, chain: { only: ['no-such-service'] } },
        testContext(),
      ),
    ).rejects.toMatchObject({ code: 'all-rungs-failed' });
    await expect(translateContext(llmOnly, gwagon30, { language: 'German please' }, testContext())).rejects.toMatchObject({
      code: 'bad-request',
    });
    await expect(
      translateContext(llmOnly, gwagon30, { language: 'de', platform: false, llm: false }, testContext()),
    ).rejects.toMatchObject({ code: 'no-transcript' });
  });
});

describe.skipIf(!process.env.LIVE)('live', () => {
  it('translates a short real video into French, keeping every timestamp', async () => {
    const { createNodeContext, createRegistry } = await import('@vid2context/registry/node');
    const ctx = createNodeContext();
    const registry = createRegistry();
    const context = await getVideoContext(registry, 'https://www.youtube.com/watch?v=jNQXAC9IVRw', { mode: 'captions' }, ctx);
    const res = await translateContext(registry, context, { language: 'fr' }, ctx);
    expect(res.transcript.language).toMatch(/^fr/);
    if (res.via === 'llm') assertTimingsKept(res.transcript, context.transcript);
    console.error(res.via, res.producer, JSON.stringify(res.transcript.segments, null, 2));
  }, 600_000);

  it('translates a real transcript with the live LLM chain (no YouTube call)', async () => {
    const { createNodeContext, createRegistry } = await import('@vid2context/registry/node');
    const ctx = createNodeContext();
    const res = await translateContext(createRegistry(), zoo, { language: 'fr', platform: false }, ctx);
    expect(res.via).toBe('llm');
    assertTimingsKept(res.transcript, zoo.transcript);
    expect(res.attempts.filter((a) => a.outcome === 'ok').length).toBeGreaterThan(0);
    for (const [i, s] of res.transcript.segments.entries()) {
      if (i !== 4) expect(s.text).not.toBe(zoo.transcript.segments[i]?.text);
    }
    console.error(res.producer, JSON.stringify(res.report), JSON.stringify(res.transcript.segments, null, 2));
  }, 600_000);
});
