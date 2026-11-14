import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CreateMessageRequest, ElicitRequest, Progress } from '@modelcontextprotocol/sdk/types.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { MemoryStorage } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDigest,
  checkNotes,
  chunkTranscript,
  collectionLatestUri,
  confirmExpensive,
  invalidCitations,
  MAP_SYSTEM,
  notifyCollectionUpdated,
  REDUCE_SYSTEM,
  sourceOf,
} from '../src/index.ts';
import {
  chainSampler,
  chatMessages,
  connect,
  FIXTURES,
  filledStorage,
  GWAGON,
  GWAGON_ID,
  type Harness,
  llmRegistry,
  QUESTION,
  RECORDED_MAX_TOKENS,
  recordedAnswer,
  resultText,
  samplingFixture,
  samplingRoutes,
  sharedContext,
  youtubeRegistry,
  youtubeRoutes,
  ZOO,
  ZOO_ID,
} from './helpers.ts';

// Real data only: the shared VideoContexts in tests/fixtures/contexts, chat completions recorded from the
// keyless OVH and Pollinations lanes (test/fixtures/README.md), and the YouTube provider's own recordings.

const zoo = sharedContext('jNQXAC9IVRw');
const gwagon = sharedContext('cCPsdFdlshc');
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});
async function harness(opts: Parameters<typeof connect>[0]): Promise<Harness> {
  const h = await connect(opts);
  open.push(h);
  return h;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('chunkTranscript', () => {
  it('cuts a long video without chapters into even windows under the budget, keeping [m:ss] markers', () => {
    const chunks = chunkTranscript(gwagon, 1, { maxTokens: RECORDED_MAX_TOKENS });
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.estimatedTokens).toBeLessThanOrEqual(RECORDED_MAX_TOKENS);
      expect(c.chapters).toEqual([]);
      for (const line of c.text.split('\n')) expect(line).toMatch(/^\[\d{1,2}:\d{2}\] \S/);
    }
    // Contiguous and complete: every segment's text lands in exactly one chunk, in order.
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks[0]?.fromSec).toBe(gwagon.transcript.segments[0]?.startSec);
    expect(chunks.at(-1)?.toSec).toBe(gwagon.transcript.segments.at(-1)?.endSec);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]?.fromSec).toBeGreaterThanOrEqual(chunks[i - 1]?.toSec ?? 0);
    const words = (s: string) =>
      s
        .replace(/\[\d+:\d+\]/g, ' ')
        .split(/\s+/)
        .filter(Boolean).length;
    const total = gwagon.transcript.segments.reduce((n, s) => n + words(s.text), 0);
    expect(chunks.reduce((n, c) => n + words(c.text), 0)).toBe(total);
  });

  it('keeps chapter boundaries and headings, packing small chapters into one chunk', () => {
    const [only, ...rest] = chunkTranscript(zoo, 0);
    expect(rest).toEqual([]);
    // "End" (0:17 to 0:19) has no speech starting in it, so no chunk covers it.
    expect(only?.chapters).toEqual(['Intro', 'The cool thing']);
    expect(zoo.metadata.chapters.map((c) => c.title)).toEqual(['Intro', 'The cool thing', 'End']);
    expect(only?.text).toContain('## Chapter: Intro (0:00)');
    expect(only?.text).toContain('## Chapter: The cool thing (0:05)');
    expect(only?.text).toContain('[0:01] All right, so here we are, in front of the elephants');
  });
});

describe('digest_videos with sampling (client model = the real LLM chain, replayed)', () => {
  const registry = llmRegistry();

  async function run() {
    const calls: CreateMessageRequest['params'][] = [];
    const chainFetch = replayFetch(samplingRoutes(samplingFixture()));
    const h = await harness({
      registry,
      ctx: testContext(),
      storage: await filledStorage(),
      capabilities: { sampling: {} },
      sampling: chainSampler(registry, testContext({ fetch: chainFetch }), { calls }),
    });
    const progress: Progress[] = [];
    const res = await h.client.callTool(
      {
        name: 'digest_videos',
        arguments: { urls: [ZOO_ID, GWAGON_ID], question: QUESTION, maxTokensPerVideo: RECORDED_MAX_TOKENS },
      },
      undefined,
      { onprogress: (p) => progress.push(p) },
    );
    return { res, calls, progress, chainFetch };
  }

  it('maps every chunk, reduces once, and returns a digest whose citations all validate', async () => {
    const { res, calls, progress } = await run();
    const out = resultText(res);
    expect(res.isError).toBeFalsy();

    const chunks =
      chunkTranscript(zoo, 0, { maxTokens: RECORDED_MAX_TOKENS }).length +
      chunkTranscript(gwagon, 1, { maxTokens: RECORDED_MAX_TOKENS }).length;
    const maps = calls.filter((c) => c.systemPrompt === MAP_SYSTEM);
    const reduces = calls.filter((c) => c.systemPrompt === REDUCE_SYSTEM);
    expect(maps).toHaveLength(chunks);
    expect(reduces).toHaveLength(1);
    expect(maps.every((c) => (c.modelPreferences?.costPriority ?? 0) >= 0.8)).toBe(true);
    expect(progress.map((p) => p.progress)).toEqual([
      ...Array.from({ length: chunks }, (_, i) => i + 1),
      chunks + 0.5,
      chunks + 1,
    ]);
    expect(progress.every((p) => p.total === chunks + 1)).toBe(true);

    // Citations are rewritten to deep links, and every one of them checks out against the transcripts.
    const links = out.match(/\[[^\]]+ @ \d+:\d{2}\]\(https:\/\/www\.youtube\.com\/watch\?v=[\w-]+&t=\d+s\)/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    expect(out).toContain('Best & Worst G-Wagon Years');
    expect(invalidCitations(out, [sourceOf(zoo), sourceOf(gwagon)])).toEqual([]);
    expect(out).toMatch(/Citation check \(tolerance 5 s\): \d+ citations verified/);
    expect(out).toContain('Sources:');
    // The recorded notes really contain one bullet without a timestamp; it is dropped and reported.
    expect(out).toMatch(/1 note line(s)? and 0 digest lines dropped/);
    expect(out).toMatch(/Dropped claims:\n- \(notes, Best & Worst G-Wagon Years[^\n]+\[no timestamp\]/);
  });

  it('sends the exact map and reduce instructions, with [m:ss] lines and the question', async () => {
    const { calls } = await run();
    const first = calls.find((c) => c.systemPrompt === MAP_SYSTEM && chatMessages(c)[1]?.content.includes('Video: Best & Worst'));
    const text = first ? chatMessages(first)[1]?.content : '';
    expect(text).toContain(`Question: ${QUESTION}`);
    expect(text).toMatch(/Transcript:\n\[0:0\d\] /);
    const reduce = calls.find((c) => c.systemPrompt === REDUCE_SYSTEM);
    expect(reduce ? chatMessages(reduce)[1]?.content : '').toContain('### Best & Worst G-Wagon Years');
  });
});

describe('citation validation on recorded model output', () => {
  const notesFor = (title: string) =>
    samplingFixture().exchanges.filter(
      (e) => e.messages[0]?.content === MAP_SYSTEM && e.messages[1]?.content.includes(`Video: ${title}`),
    );

  it('keeps the real notes that cite real moments', () => {
    const chunks = chunkTranscript(gwagon, 1, { maxTokens: RECORDED_MAX_TOKENS });
    const recorded = notesFor(gwagon.metadata.title);
    expect(recorded).toHaveLength(chunks.length);
    for (const e of recorded) {
      const chunk = chunks.find((c) => e.messages[1]?.content.includes(c.text));
      expect(chunk).toBeDefined();
      const checked = checkNotes(recordedAnswer(e), sourceOf(gwagon), { range: chunk });
      expect(checked.verified).toBeGreaterThan(0);
    }
  });

  it('drops claims whose timestamps do not exist in the cited video', () => {
    // The recorded digest run produced no out-of-range timestamp, so check the validator on the model's real
    // G-Wagon notes (moments up to 18 minutes in) against the 19-second "Me at the zoo": everything past
    // 0:19 must go, and only lines whose every timestamp exists in that video may stay.
    const text = notesFor(gwagon.metadata.title).map(recordedAnswer).join('\n');
    const checked = checkNotes(text, sourceOf(zoo));
    const late = checked.dropped.filter((d) => d.reason.includes('past the end of the video (0:19)'));
    expect(late.length).toBeGreaterThan(20);
    for (const line of checked.text.split('\n').filter((l) => l.trim().startsWith('-'))) {
      for (const m of line.matchAll(/\[(\d+):(\d{2})\]/g)) expect(Number(m[1]) * 60 + Number(m[2])).toBeLessThanOrEqual(19);
    }
  });

  it('rewrites titled citations to deep links and drops lines that cite a moment that does not exist', () => {
    const sources = [sourceOf(zoo), sourceOf(gwagon)];
    const reduce = samplingFixture().exchanges.find((e) => e.messages[0]?.content === REDUCE_SYSTEM);
    expect(reduce).toBeDefined();
    const checked = checkDigest(reduce ? recordedAnswer(reduce) : '', sources);
    expect(checked.citations).toBeGreaterThan(0);
    expect(invalidCitations(checked.text, sources)).toEqual([]);
    // The zoo video is 19 s long, so a citation at 2:00 in it cannot be real.
    const bad = checkDigest('- Elephants have long trunks [Me at the zoo @ 2:00]', sources);
    expect(bad.text).toBe('');
    expect(bad.dropped[0]?.reason).toContain('past the end of the video (0:19)');
  });
});

describe('citation formats real models write', () => {
  // The raw combine output gpt-oss returned in a live run (fixtures/reduce-gpt-oss-lenticular.md): citations in
  // lenticular brackets, a non-breaking hyphen inside the title, and many bare timestamps.
  const raw = readFileSync(join(FIXTURES, 'reduce-gpt-oss-lenticular.md'), 'utf8');
  const sources = [sourceOf(zoo), sourceOf(gwagon)];

  it('checks lenticular-bracket citations instead of letting them through unverified', () => {
    expect(raw).toContain('\u3010Best & Worst G\u2011Wagon Years');
    expect(invalidCitations(raw, sources).length).toBeGreaterThan(10);
    const checked = checkDigest(raw, sources);
    expect(checked.citations).toBeGreaterThan(20);
    expect(invalidCitations(checked.text, sources)).toEqual([]);
    expect(checked.text).toContain(
      '[Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked! @ 8:34](https://www.youtube.com/watch?v=cCPsdFdlshc&t=514s)',
    );
    expect(checked.text).not.toContain('\u3010');
  });

  it('attributes a bare timestamp only to the one source where that moment exists', () => {
    // 8:34 exists only in the 18-minute G-Wagon video; 0:05 exists in both videos, so it cannot be traced.
    expect(checkDigest('- Early G500s are the best value \u30108:34\u3011', sources).citations).toBe(1);
    const ambiguous = checkDigest('- Something was said \u30100:05\u3011', sources);
    expect(ambiguous.text).toBe('');
    expect(ambiguous.dropped[0]?.reason).toBe('[0:05] does not say which video it cites');
  });
});

describe('digest_videos without client sampling', () => {
  it('returns the chunk plan and the exact instructions instead of an error', async () => {
    const h = await harness({ registry: llmRegistry(), ctx: testContext(), storage: await filledStorage() });
    const res = await h.client.callTool({
      name: 'digest_videos',
      arguments: { urls: [ZOO_ID, GWAGON_ID], question: QUESTION, maxTokensPerVideo: RECORDED_MAX_TOKENS },
    });
    expect(res.isError).toBeFalsy();
    const plan = JSON.parse(resultText(res));
    expect(plan.mode).toBe('chunk-plan');
    expect(plan.videos.map((v: { id: string }) => v.id)).toEqual(['youtube:jNQXAC9IVRw', 'youtube:cCPsdFdlshc']);
    expect(plan.chunks).toHaveLength(4);
    expect(plan.chunks[1]).toMatchObject({ video: 2, chunk: 1, of: 3, from: '0:00', fetch: { tool: 'get_section' } });
    expect(plan.mapInstructions).toBe(MAP_SYSTEM);
    expect(plan.reduceInstructions).toBe(REDUCE_SYSTEM);
    expect(plan.videos[1].timestampLink).toBe('https://www.youtube.com/watch?v=cCPsdFdlshc&t={seconds}s');
  });

  it('digests a collection by name from storage', async () => {
    const storage = await filledStorage();
    const col = await storage.createCollection({ name: 'G-Wagon research' });
    await storage.addToCollection(col.id, ['youtube:cCPsdFdlshc']);
    const h = await harness({ registry: llmRegistry(), ctx: testContext(), storage });
    const plan = JSON.parse(
      resultText(await h.client.callTool({ name: 'digest_videos', arguments: { collection: 'g-wagon research' } })),
    );
    expect(plan.videos).toHaveLength(1);
    expect(plan.chunks).toHaveLength(1);
  });
});

describe('choose_caption_track (elicitation)', () => {
  const ctx = () => testContext({ fetch: replayFetch(youtubeRoutes()) });

  it('asks the user to pick a track and returns that transcript', async () => {
    const asked: ElicitRequest['params'][] = [];
    const h = await harness({
      registry: await youtubeRegistry(),
      ctx: ctx(),
      storage: null,
      capabilities: { elicitation: {} },
      elicit: async (req) => {
        asked.push(req.params);
        return { action: 'accept', content: { track: 'de:creator' } };
      },
    });
    const out = resultText(await h.client.callTool({ name: 'choose_caption_track', arguments: { url: ZOO } }));
    const schema = (asked[0] as { requestedSchema?: { properties: { track: { oneOf: { const: string; title: string }[] } } } })
      .requestedSchema;
    expect(schema?.properties.track.oneOf).toEqual([
      { const: 'en:creator', title: 'English' },
      { const: 'de:creator', title: 'German' },
    ]);
    expect(out).toContain('Title: Me at the zoo');
    expect(out).toContain('Transcript: creator-captions, de (youtube-captions)');
    expect(out).toMatch(/\[0:0\d\] /);
  });

  it('returns the track list when the user declines', async () => {
    const h = await harness({
      registry: await youtubeRegistry(),
      ctx: ctx(),
      storage: null,
      capabilities: { elicitation: {} },
      elicit: async () => ({ action: 'decline' }),
    });
    const out = resultText(await h.client.callTool({ name: 'choose_caption_track', arguments: { url: ZOO } }));
    expect(out).toContain('"Me at the zoo" has 2 caption tracks:');
    expect(out).toContain('- de: German (creator-captions, translatable)');
    expect(out).toContain('The user declined the picker.');
  });

  it('returns the track list and the get_transcript call when the client cannot elicit', async () => {
    const h = await harness({ registry: await youtubeRegistry(), ctx: ctx(), storage: null });
    const out = resultText(await h.client.callTool({ name: 'choose_caption_track', arguments: { url: ZOO } }));
    expect(out).toContain('no MCP elicitation support');
    expect(out).toContain(
      'call get_transcript with {"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "language": "<code>"}',
    );
  });

  it('fetches the only track without asking', async () => {
    let asked = 0;
    const h = await harness({
      registry: await youtubeRegistry(),
      ctx: ctx(),
      storage: null,
      capabilities: { elicitation: {} },
      elicit: async () => {
        asked++;
        return { action: 'cancel' };
      },
    });
    const out = resultText(await h.client.callTool({ name: 'choose_caption_track', arguments: { url: GWAGON } }));
    expect(asked).toBe(0);
    expect(out).toContain('Transcript: auto-captions, en (youtube-captions)');
  });
});

describe('confirmExpensive', () => {
  const env = { VID2CONTEXT_CONFIRM_STT_MINUTES: '30' };

  it('accepts below the threshold without asking, and asks above it', async () => {
    const answers: ('accept' | 'decline')[] = ['accept', 'decline'];
    const messages: string[] = [];
    const h = await harness({
      registry: llmRegistry(),
      ctx: testContext({ env }),
      storage: null,
      capabilities: { elicitation: {} },
      elicit: async (req) => {
        messages.push(req.params.message);
        const action = answers.shift() ?? 'decline';
        return action === 'accept' ? { action, content: { confirm: true } } : { action };
      },
    });
    const message = 'Transcribe this video with speech-to-text?';
    expect(await confirmExpensive(h.server, { message, estimateMinutes: 25 })).toBe('accept');
    expect(messages).toEqual([]);
    expect(await confirmExpensive(h.server, { message, estimateMinutes: 42 })).toBe('accept');
    expect(await confirmExpensive(h.server, { message, estimateMinutes: 42 })).toBe('decline');
    expect(messages[0]).toBe('Transcribe this video with speech-to-text? (about 42 minutes of audio)');
  });

  it('reports unsupported when the client cannot elicit', async () => {
    const h = await harness({ registry: llmRegistry(), ctx: testContext({ env }), storage: null });
    expect(await confirmExpensive(h.server, { message: 'Transcribe?', estimateMinutes: 60 })).toBe('unsupported');
    expect(
      await confirmExpensive(h.server, {
        message: 'Transcribe?',
        estimateMinutes: 60,
        env: { VID2CONTEXT_CONFIRM_STT_MINUTES: '90' },
      }),
    ).toBe('accept');
  });
});

describe('completions', () => {
  it('completes collection ids and names, and saved video ids and titles, by prefix', async () => {
    const storage = await filledStorage();
    const col = await storage.createCollection({ name: 'G-Wagon research' });
    const h = await harness({ registry: llmRegistry(), ctx: testContext(), storage });
    const complete = async (name: string, value: string) =>
      (await h.client.complete({ ref: { type: 'ref/prompt', name: 'digest' }, argument: { name, value } })).completion.values;

    expect(await complete('collection', 'g-')).toEqual([col.id, 'G-Wagon research']);
    expect(await complete('collection', 'zzz')).toEqual([]);
    expect(await complete('urls', 'me at')).toEqual(['Me at the zoo']);
    expect(await complete('urls', 'youtube:c')).toEqual(['youtube:cCPsdFdlshc']);
    expect(await complete('urls', 'youtube:jNQXAC9IVRw, Best')).toEqual([
      'youtube:jNQXAC9IVRw, Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!',
    ]);
    const ids = await h.client.complete({
      ref: { type: 'ref/resource', uri: 'vid2context://collection/{id}/latest' },
      argument: { name: 'id', value: 'g' },
    });
    expect(ids.completion.values).toEqual([col.id]);
  });

  it('builds prompt messages that drive digest_videos with saved ids and titles', async () => {
    const h = await harness({ registry: llmRegistry(), ctx: testContext(), storage: await filledStorage() });
    const prompt = await h.client.getPrompt({
      name: 'digest',
      arguments: { urls: 'youtube:jNQXAC9IVRw, Me at the zoo', question: 'Why?' },
    });
    const msg = prompt.messages[0]?.content;
    expect(msg?.type === 'text' ? msg.text : '').toContain(
      'Call the digest_videos tool with {"urls":["youtube:jNQXAC9IVRw","Me at the zoo"],"question":"Why?"}',
    );
  });
});

describe('collection subscriptions', () => {
  it('notifies only the subscribed client when a collection gains a video', async () => {
    const storage = new MemoryStorage();
    await storage.putContext(zoo);
    const col = await storage.createCollection({ name: 'Watched channel' });
    await storage.addToCollection(col.id, [zoo.metadata.ref.id]);
    const a = await harness({ registry: llmRegistry(), ctx: testContext(), storage });
    const b = await harness({ registry: llmRegistry(), ctx: testContext(), storage });
    const gotA: string[] = [];
    const gotB: string[] = [];
    a.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      gotA.push(n.params.uri);
    });
    b.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      gotB.push(n.params.uri);
    });
    expect(a.client.getServerCapabilities()?.resources?.subscribe).toBe(true);

    const uri = collectionLatestUri(col.id);
    await a.client.subscribeResource({ uri });
    await storage.putContext(gwagon);
    await storage.addToCollection(col.id, [gwagon.metadata.ref.id]);
    expect(await notifyCollectionUpdated(col.id)).toBe(1);
    expect(await notifyCollectionUpdated(b.server, col.id)).toBe(0);
    await tick();
    expect(gotA).toEqual([uri]);
    expect(gotB).toEqual([]);

    const read = await a.client.readResource({ uri });
    const body = JSON.parse(String((read.contents[0] as { text?: string }).text));
    expect(body.collection).toMatchObject({ id: col.id, name: 'Watched channel', videoCount: 2 });
    expect(body.latest.map((v: { id: string }) => v.id)).toEqual(['youtube:cCPsdFdlshc', 'youtube:jNQXAC9IVRw']);

    await a.client.unsubscribeResource({ uri });
    expect(await notifyCollectionUpdated(a.server, col.id)).toBe(0);
  });

  it('lists a latest resource per collection and rejects foreign URIs', async () => {
    const storage = await filledStorage();
    const col = await storage.createCollection({ name: 'Zoo' });
    const h = await harness({ registry: llmRegistry(), ctx: testContext(), storage });
    const list = await h.client.listResources();
    expect(list.resources.map((r) => r.uri)).toContain(collectionLatestUri(col.id));
    await expect(h.client.subscribeResource({ uri: 'file:///etc/passwd' })).rejects.toThrow(/only serves vid2context/);
  });
});
