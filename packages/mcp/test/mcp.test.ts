import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { estimateTokens, formatters } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { COMMENTS_VIDEO, call, connect, GWAGON, GWAGON_PLAYLIST, jsonOf, root, type TextResult, textOf, ZOO } from './helpers.ts';

/** Tools this package defines. */
const OWN_TOOLS = [
  'get_transcript',
  'get_metadata',
  'list_formats',
  'get_outline',
  'get_section',
  'list_items',
  'get_comments',
  'export_context_pack',
  'list_models',
];

/** Tools other packages register through their src/mcp.ts (wire.ts). */
const WIRED_TOOLS = [
  'search_transcript',
  'extract',
  'build_brief',
  'list_collections',
  'create_collection',
  'add_to_collection',
  'get_collection',
  'ask',
  'research_videos',
  'list_caption_languages',
  'get_key_moments',
  'get_skip_segments',
  'export_obsidian',
  'export_notion',
  'find_duplicates',
  'watch_live',
  'open_transcript_viewer',
  'digest_videos',
  'choose_caption_track',
];

describe('tool list', () => {
  it('exposes every own and wired tool, each with a description, input schema and truthful annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [...OWN_TOOLS, ...WIRED_TOOLS]) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);

    for (const name of OWN_TOOLS) {
      const t = tools.find((x) => x.name === name);
      expect(t?.description?.length, name).toBeGreaterThan(80);
      expect(t?.description, name).toMatch(/tokens/);
      expect(t?.inputSchema.type).toBe('object');
      expect(t?.annotations?.readOnlyHint, name).toBe(true);
      expect(t?.annotations?.idempotentHint, name).toBe(true);
    }
    const props = (name: string) =>
      tools.find((t) => t.name === name)?.inputSchema.properties as Record<string, { description?: string }>;
    expect(Object.keys(props('get_transcript'))).toEqual(
      expect.arrayContaining(['url', 'format', 'timestamps', 'mode', 'language', 'maxTokens', 'cursor']),
    );
    expect(Object.keys(props('get_section'))).toEqual(
      expect.arrayContaining(['url', 'from', 'to', 'chapter', 'format', 'timestamps']),
    );
    for (const [field, schema] of Object.entries(props('get_section'))) expect(schema.description, field).toBeTruthy();

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_formats?.annotations?.openWorldHint).toBe(false);
    expect(byName.get_transcript?.annotations?.openWorldHint).toBe(true);
    for (const name of ['get_outline', 'list_formats', 'list_models', 'list_items', 'get_comments']) {
      expect(byName[name]?.outputSchema?.type, name).toBe('object');
    }
    // Collection writes are not read-only.
    expect(byName.create_collection?.annotations?.readOnlyHint).not.toBe(true);
  });

  it('describes the reading strategy in the server instructions', async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain('get_outline first');
  });
});

describe('get_transcript', () => {
  it('returns a header plus a timestamped transcript', async () => {
    const { client } = await connect();
    const res = await call(client, 'get_transcript', { url: 'https://youtu.be/jNQXAC9IVRw' });
    const out = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(out).toContain('Title: Me at the zoo\nChannel: jawed\nURL: https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(out).toContain('Chapters: 0:00 Intro | 0:05 The cool thing | 0:17 End');
    expect(out).toContain("[0:12] and that's cool");
    expect(out).not.toContain('next_cursor');
  });

  it('pages a long transcript with maxTokens and a cursor until the end, losing no line', async () => {
    const { client } = await connect();
    const whole = textOf(await call(client, 'get_transcript', { url: GWAGON }));
    const wholeLines = whole.split('\n').filter((l) => l.startsWith('['));
    expect(estimateTokens(whole)).toBeGreaterThan(6000);

    const maxTokens = 2500;
    const lines: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await call(client, 'get_transcript', { url: GWAGON, maxTokens, ...(cursor ? { cursor } : {}) });
      const out = textOf(res);
      expect(res.isError).toBeFalsy();
      expect(out).toContain('Title: Best & Worst G-Wagon Years');
      expect(estimateTokens(out)).toBeLessThanOrEqual(maxTokens);
      lines.push(...out.split('\n').filter((l) => /^\[\d/.test(l)));
      cursor = /next_cursor: (seg:\d+)/.exec(out)?.[1];
      if (!cursor) expect(out).toContain('[End of transcript:');
      pages++;
    } while (cursor && pages < 50);
    expect(pages).toBeGreaterThan(2);
    expect(lines).toEqual(wholeLines);
  });

  it('pages other formats into complete documents (JSON pages parse)', async () => {
    const { client } = await connect();
    const out = textOf(await call(client, 'get_transcript', { url: GWAGON, format: 'json', maxTokens: 3000 }));
    const cursor = /next_cursor: (seg:\d+)/.exec(out)?.[1];
    expect(cursor).toBeDefined();
    const doc = JSON.parse(out.slice(0, out.lastIndexOf('\n[Partial transcript')));
    expect(doc.transcript.segments.length).toBe(Number(cursor?.slice(4)));
  });

  it('rejects a cursor it did not issue with a bad-request error and a hint', async () => {
    const { client } = await connect();
    const res = await call(client, 'get_transcript', { url: ZOO, cursor: 'page-2' });
    expect(res.isError).toBe(true);
    expect(jsonOf(res)).toMatchObject({ error: 'bad-request', hint: expect.stringContaining('seg:') });
  });

  it('returns failures as tool errors with code, hint, attempts and what to do next', async () => {
    const { client } = await connect();
    const bad = await call(client, 'get_transcript', { url: 'xxxxxxxxxxx' });
    expect(bad.isError).toBe(true);
    expect(jsonOf(bad)).toMatchObject({
      error: 'not-found',
      hint: expect.stringContaining('removed'),
      attempts: expect.any(Array),
      // No downloader: this is the remote server, so a local file path is not suggested.
      recovery: [expect.objectContaining({ action: 'fix-input', title: 'Check the link' })],
    });
  });
});

describe('get_metadata and list_formats', () => {
  it('returns metadata as JSON', async () => {
    const { client } = await connect();
    const meta = await call(client, 'get_metadata', { url: 'jNQXAC9IVRw' });
    expect(jsonOf(meta)).toMatchObject({ title: 'Me at the zoo', durationSec: 19 });
  });

  it('lists every formatter from the core map', async () => {
    const { client } = await connect();
    const res = await call(client, 'list_formats');
    const formats = (res.structuredContent as { formats: { id: string; combinesVideos: boolean }[] }).formats;
    expect(formats.map((f) => f.id)).toEqual(Object.keys(formatters));
    expect(formats.find((f) => f.id === 'pack')?.combinesVideos).toBe(true);
    expect(formats.find((f) => f.id === 'srt')?.combinesVideos).toBe(false);
    expect(jsonOf(res)).toEqual(res.structuredContent);
  });
});

type Outline = {
  title: string;
  sections: string;
  totalTokens: number;
  chapters: { index: number; title: string; startSec: number; start: string; tokens: number; url?: string }[];
};

describe('get_outline', () => {
  it('lists the video chapters with token counts and timestamp links', async () => {
    const { client } = await connect();
    const res = await call(client, 'get_outline', { url: ZOO });
    const o = res.structuredContent as Outline;
    expect(res.isError).toBeFalsy();
    expect(o.sections).toBe('chapters');
    expect(o.chapters.map((c) => [c.index, c.title, c.start])).toEqual([
      [0, 'Intro', '0:00'],
      [1, 'The cool thing', '0:05'],
      [2, 'End', '0:17'],
    ]);
    expect(o.chapters[1]?.url).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s');
    expect(o.chapters.reduce((s, c) => s + c.tokens, 0)).toBe(o.totalTokens);
    expect(o.totalTokens).toBeGreaterThan(0);
  });

  it('cuts a video without chapters into sections of about five minutes', async () => {
    const { client } = await connect();
    const o = (await call(client, 'get_outline', { url: GWAGON })).structuredContent as Outline;
    expect(o.sections).toBe('time');
    expect(o.chapters.length).toBeGreaterThan(2);
    for (const c of o.chapters) expect(c.url).toMatch(/&t=\d+s$/);
    expect(o.totalTokens).toBeGreaterThan(3000);
  });
});

describe('get_section', () => {
  it('reads a chapter by index and by title', async () => {
    const { client } = await connect();
    const byIndex = textOf(await call(client, 'get_section', { url: ZOO, chapter: 1 }));
    expect(byIndex).toContain('Section "The cool thing": 0:05 to 0:17');
    expect(byIndex).toContain("[0:12] and that's cool");
    expect(byIndex).not.toMatch(/^\[0:0[0-4]\]/m);
    const byTitle = textOf(await call(client, 'get_section', { url: ZOO, chapter: 'cool' }));
    expect(byTitle).toBe(byIndex);
  });

  it('reads a time range given as m:ss or seconds', async () => {
    const { client } = await connect();
    const a = textOf(await call(client, 'get_section', { url: ZOO, from: '0:05', to: '0:17' }));
    const b = textOf(await call(client, 'get_section', { url: ZOO, from: 5, to: '17' }));
    expect(a).toBe(b);
    expect(a).toContain('Section: 0:05 to 0:17');
    expect(a).toContain("[0:12] and that's cool");
  });

  it('explains bad selectors with hints', async () => {
    const { client } = await connect();
    const none = await call(client, 'get_section', { url: ZOO });
    expect(jsonOf(none)).toMatchObject({ error: 'bad-request', hint: expect.stringContaining('get_outline') });
    const badTime = await call(client, 'get_section', { url: ZOO, from: 'noon' });
    expect(jsonOf(badTime)).toMatchObject({ error: 'bad-request', hint: expect.stringContaining('m:ss') });
    const badChapter = await call(client, 'get_section', { url: ZOO, chapter: 'zebras' });
    expect(jsonOf(badChapter)).toMatchObject({ error: 'bad-request', hint: expect.stringContaining('1: The cool thing') });
  });
});

describe('list_items', () => {
  it('expands a playlist into its videos', async () => {
    const { client } = await connect();
    const res = await call(client, 'list_items', { url: GWAGON_PLAYLIST, limit: 5 });
    const out = res.structuredContent as { count: number; items: { id: string; kind: string; url?: string }[] };
    expect(res.isError).toBeFalsy();
    expect(out.count).toBe(5);
    for (const item of out.items) {
      expect(item.kind).toBe('video');
      expect(item.id).toMatch(/^youtube:[\w-]{11}$/);
    }
  });

  it('returns a single video as itself', async () => {
    const { client } = await connect();
    const out = (await call(client, 'list_items', { url: ZOO })).structuredContent as { items: { id: string }[] };
    expect(out.items.map((i) => i.id)).toEqual(['youtube:jNQXAC9IVRw']);
  });
});

describe('get_comments', () => {
  it('returns top comments with the pinned creator comment flagged', async () => {
    const { client, fetch } = await connect();
    const res = await call(client, 'get_comments', { url: COMMENTS_VIDEO, limit: 5 });
    const out = res.structuredContent as {
      count: number;
      comments: { author: string; text: string; isCreator?: boolean; isPinned?: boolean }[];
    };
    expect(res.isError).toBeFalsy();
    expect(out.count).toBe(5);
    expect(out.comments[0]).toMatchObject({ isPinned: true, isCreator: true });
    expect(out.comments.every((c) => c.text.length > 0)).toBe(true);
    // One `next` for the video, one continuation for the first page of 20 threads.
    expect(fetch.calls.filter((c) => c.url.includes('/next')).length).toBe(2);
  });
});

describe('collections and context packs', () => {
  it('creates a collection, adds videos, searches it, packs it and reads it as a resource', async () => {
    const { client } = await connect();
    const created = jsonOf<{ id: string; name: string }>(await call(client, 'create_collection', { name: 'Test series' }));
    expect(created.name).toBe('Test series');
    const added = await call(client, 'add_to_collection', { collection: created.id, urls: [ZOO, GWAGON] });
    expect(added.isError).toBeFalsy();

    const listed = jsonOf<{ collections: { id: string }[] }>(await call(client, 'list_collections'));
    expect(listed.collections.map((c) => c.id)).toContain(created.id);

    // search_transcript is @vid2context/search's tool, wired in with the same storage.
    const hits = textOf(await call(client, 'search_transcript', { query: 'elephants', collection: created.id }));
    expect(hits).toContain('Me at the zoo');
    expect(hits).toContain('jNQXAC9IVRw&t=');

    const pack = textOf(await call(client, 'export_context_pack', { collection: created.id }));
    expect(pack).toContain('Me at the zoo');
    expect(pack).toContain('Best & Worst G-Wagon Years');

    const small = textOf(await call(client, 'export_context_pack', { collection: created.id, maxTokens: 1500 }));
    expect(estimateTokens(small)).toBeLessThan(estimateTokens(pack));

    const { resources } = await client.listResources();
    const uri = `vid2context://collection/${encodeURIComponent(created.id)}`;
    expect(resources.map((r) => r.uri)).toContain(uri);
    const read = await client.readResource({ uri });
    const view = JSON.parse(String((read.contents[0] as { text: string }).text)) as {
      videos: { title: string; tokens: number }[];
      totalTokens: number;
    };
    expect(view.videos.map((v) => v.title).sort()).toEqual([
      expect.stringMatching(/^Best & Worst G-Wagon Years/),
      'Me at the zoo',
    ]);
    expect(view.totalTokens).toBe(view.videos.reduce((s, v) => s + v.tokens, 0));
  });

  it('packs urls directly with progress, lists what it could not read, and needs urls or a collection', async () => {
    const { client } = await connect();
    const progress: number[] = [];
    const res = (await client.callTool(
      { name: 'export_context_pack', arguments: { urls: [ZOO, GWAGON, 'xxxxxxxxxxx'] } },
      undefined,
      { onprogress: (p) => progress.push(p.progress) },
    )) as unknown as TextResult;
    const pack = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(pack).toContain('Me at the zoo');
    expect(pack).toMatch(/Not included:\n- Could not read .*xxxxxxxxxxx/);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    const none = await call(client, 'export_context_pack', {});
    expect(jsonOf(none)).toMatchObject({ error: 'bad-request', hint: expect.stringContaining('urls') });
  });
});

describe('list_models', () => {
  it('lists rungs with tiers and env var names, never key values', async () => {
    const secret = 'gsk_live_value_that_must_never_appear_0123456789';
    const { client } = await connect({ env: { GROQ_API_KEY: secret, OPENAI_API_KEY: `${secret}-openai` } });
    const res = await call(client, 'list_models', { kind: 'llm' });
    const raw = JSON.stringify(res);
    expect(raw).not.toContain(secret);
    const { models, defaultPolicy } = res.structuredContent as {
      models: {
        kind: string;
        service: string;
        enabled: boolean;
        requires: string[];
        tier: string;
        label: string;
        model: string;
      }[];
      defaultPolicy: string;
    };
    expect(defaultPolicy).toBe('free');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.kind === 'llm')).toBe(true);
    const groq = models.filter((m) => m.service === 'groq');
    expect(groq.length).toBeGreaterThan(0);
    expect(groq.every((m) => m.enabled && m.requires.includes('GROQ_API_KEY') && m.tier === 'free')).toBe(true);
    expect(models.filter((m) => m.service === 'cerebras').every((m) => !m.enabled)).toBe(true);
    for (const m of models) expect(m.label).toBe(m.model.split('/').pop());
  });
});

describe('prompts and resources', () => {
  it('lists the brief and buyer_guide prompts and renders citation instructions', async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['brief', 'buyer_guide']));

    const brief = await client.getPrompt({
      name: 'brief',
      arguments: { urls: `${ZOO}, ${GWAGON}`, question: 'Which years to buy?' },
    });
    const text = (brief.messages[0]?.content as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('Which years to buy?');
    expect(text).toContain(`   - ${ZOO}\n   - ${GWAGON}`);
    expect(text).toContain('[Video title @ m:ss](timestamp link)');
    for (const tool of ['get_outline', 'get_section', 'search_transcript']) expect(text).toContain(tool);
    expect(text).toMatch(/consensus/i);
    expect(text).toMatch(/disagree/i);

    const guide = await client.getPrompt({
      name: 'buyer_guide',
      arguments: { product: 'Mercedes G-Class', collection: 'g-wagon' },
    });
    const g = (guide.messages[0]?.content as { text?: string } | undefined)?.text ?? '';
    expect(g).toContain('buyer guide for Mercedes G-Class');
    expect(g).toContain('get_collection { "collection": "g-wagon" }');
    expect(g).toContain('Known issues');
  });

  it('lists saved videos as resources and reads the context and the transcript', async () => {
    const { client } = await connect();
    await call(client, 'get_transcript', { url: ZOO });
    const { resources } = await client.listResources();
    const video = 'vid2context://video/youtube%3AjNQXAC9IVRw';
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining([video, `${video}/transcript`]));
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(
      expect.arrayContaining([
        'vid2context://video/{id}',
        'vid2context://video/{id}/transcript',
        'vid2context://collection/{id}',
      ]),
    );

    const ctx = await client.readResource({ uri: video });
    expect(JSON.parse(String((ctx.contents[0] as { text: string }).text)).metadata.title).toBe('Me at the zoo');
    const tr = await client.readResource({ uri: `${video}/transcript` });
    const t = String((tr.contents[0] as { text: string }).text);
    expect(t).toContain('Title: Me at the zoo');
    expect(t).toContain("[0:12] and that's cool");
  });
});

describe('stdio server', () => {
  it('starts from the bin, lists every tool and keeps stdout clean for the protocol', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'packages/mcp/src/bin.ts')],
      env: { PATH: process.env.PATH ?? '', VID2CONTEXT_LOG_LEVEL: 'info' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const n of OWN_TOOLS) expect(tools.map((t) => t.name)).toContain(n);
    await client.close();
  });
});
