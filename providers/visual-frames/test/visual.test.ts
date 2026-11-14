import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptsOf, clearCooldowns, rankRungs, runChain, Vid2ContextError, type VisualNote } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { parseShowinfoTimes } from '@vid2context/ffmpeg';
import { decode } from 'jpeg-js';
import { beforeEach, describe, expect, it } from 'vitest';
import edgeProvider from '../src/edge.ts';
import {
  answerText,
  buildVisionBody,
  clock,
  DEFAULT_HASH_THRESHOLD,
  dedupeFrames,
  dHash,
  grayFromRgba,
  hammingDistance,
  mapKind,
  mergeNotes,
  notesFromReply,
  OVH_CHAT_URL,
  parseJsonObject,
  resetThrottle,
  resizeGray,
  selectBudget,
  sharpness,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  textFromBlocks,
  textSimilarity,
  throttleRemainingMs,
  visualRungs,
} from '../src/index.ts';
import {
  downloadArgs,
  framesFromThumbs,
  onlyRateLimited,
  parseDuration,
  resolveSampleOptions,
  samplingArgs,
  selectExpression,
} from '../src/node/index.ts';
import nodeProvider, { nodeLangSource } from '../src/node-provider.ts';
import { terminateTesseract } from '../src/tesseract.ts';

// Real data only: frames from the CC BY-SA "New Editor Experiences" talk, real OVH responses
// recorded 2026-11-14, and a real ffmpeg sampling run (see test/fixtures/README.md).
const FIX = join(import.meta.dirname, 'fixtures');
const bytes = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));
const text = (name: string) => readFileSync(join(FIX, name), 'utf8');
const FRAME_SECS = ['005', '030', '050', '062', '085', '100', '112'] as const;
type FrameSec = (typeof FRAME_SECS)[number];
const frameFile = (s: FrameSec) => `frame-${s}s.jpg`;
const ovhFile = (s: FrameSec) => `ovh-qwen2.5-vl-72b.frame-${s}s.json`;
const frame = (s: FrameSec) => ({ data: bytes(frameFile(s)), mimeType: 'image/jpeg', atSec: Number(s) });

function hashOf(s: FrameSec) {
  const img = decode(readFileSync(join(FIX, frameFile(s))), { useTArray: true, formatAsRGBA: true });
  const thumb = resizeGray(grayFromRgba(img.data, img.width, img.height), THUMB_WIDTH, THUMB_HEIGHT);
  return { hash: dHash(thumb), sharpness: sharpness(thumb) };
}

function ovhRung(env: Record<string, string> = {}) {
  const rung = visualRungs(env).find((r) => r.service === 'ovh');
  if (!rung) throw new Error('no ovh rung');
  return rung;
}

function recordedNote(s: FrameSec): VisualNote {
  const obj = parseJsonObject(answerText(JSON.parse(text(ovhFile(s)))));
  if (!obj) throw new Error(`fixture ${s} is not JSON`);
  const [note] = notesFromReply(obj, Number(s), 'visual/ovh/Qwen2.5-VL-72B-Instruct');
  if (!note) throw new Error(`fixture ${s} has no note`);
  return note;
}

beforeEach(() => {
  resetThrottle();
  clearCooldowns();
});

describe('dHash on real frames', () => {
  const h = Object.fromEntries(FRAME_SECS.map((s) => [s, hashOf(s)])) as Record<FrameSec, ReturnType<typeof hashOf>>;

  it('is 64 bits as 16 hex characters', () => {
    for (const s of FRAME_SECS) expect(h[s].hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the same slide within the threshold even when the burned-in subtitle changes', () => {
    expect(hammingDistance(h['050'].hash, h['062'].hash)).toBeLessThanOrEqual(DEFAULT_HASH_THRESHOLD);
    expect(hammingDistance(h['085'].hash, h['100'].hash)).toBeLessThanOrEqual(DEFAULT_HASH_THRESHOLD);
  });

  it('puts different pictures far apart', () => {
    const different: [FrameSec, FrameSec][] = [
      ['005', '030'],
      ['030', '050'],
      ['050', '085'],
      ['085', '112'],
      ['005', '112'],
    ];
    for (const [a, b] of different) expect(hammingDistance(h[a].hash, h[b].hash)).toBeGreaterThan(DEFAULT_HASH_THRESHOLD + 5);
  });

  it('collapses consecutive look-alikes, keeping the sharpest frame and the first time', () => {
    const sampled = FRAME_SECS.map((s, index) => ({ index, atSec: Number(s), ...h[s] }));
    const distinct = dedupeFrames(sampled);
    expect(distinct.map((d) => d.atSec)).toEqual([5, 30, 50, 85, 112]);
    const chart = distinct.find((d) => d.atSec === 50);
    expect(chart?.runLength).toBe(2);
    const sharper = h['050'].sharpness >= h['062'].sharpness ? 50 : 62;
    expect(chart?.best.atSec).toBe(sharper);
  });
});

describe('ffmpeg sampling output (recorded run, max interval 5 s)', () => {
  const stderr = text('sampled-max5.stderr.txt').split('\n');
  const times = parseShowinfoTimes(stderr);
  const frames = framesFromThumbs(bytes('sampled-max5.thumbs.gray'), times);

  it('parses one time and one thumbnail per selected frame, and the duration', () => {
    expect(times).toHaveLength(25);
    expect(frames).toHaveLength(25);
    expect(times.slice(0, 3)).toEqual([0, 5, 10]);
    // Settled frames: 1 s after the scene changes at 36.3 s (chart) and 79.4 s (code screen).
    expect(times).toContain(37.333333);
    expect(times).toContain(80.4);
    expect(parseDuration(stderr)).toBe(120);
  });

  it('dedupes the talk into its scenes', () => {
    const distinct = dedupeFrames(frames);
    // Fade-in, speakers, title slide, chart, split screen, code screen, rendered article.
    expect(distinct.map((d) => d.atSec)).toEqual([0, 5, 30, 37.333333, 72.366667, 80.4, 110.433333]);
    const code = distinct.find((d) => d.atSec === 80.4);
    expect(code?.runLength).toBe(6);
  });

  it('keeps the biggest changes spread across the duration within the budget', () => {
    const distinct = dedupeFrames(frames);
    const chosen = selectBudget(distinct, 4, 120);
    expect(chosen).toHaveLength(4);
    expect(chosen.map((c) => c.atSec)).toEqual([...chosen.map((c) => c.atSec)].sort((a, b) => a - b));
    // One frame per 30 s window: every quarter of the talk is represented.
    for (let w = 0; w < 4; w++) expect(chosen.some((c) => c.atSec >= w * 30 && c.atSec < (w + 1) * 30)).toBe(true);
    // Under the budget nothing is dropped.
    expect(selectBudget(distinct, 40, 120)).toHaveLength(distinct.length);
  });

  it('builds a scene select with min and max intervals, two outputs and no shell quoting', () => {
    const o = { sceneThreshold: 0.3, minIntervalSec: 2, maxIntervalSec: 30, settleSec: 1, width: 1024, quality: 3 };
    expect(selectExpression(o)).toBe(
      'if(gt(scene,0.3),st(0,t+1));' +
        'st(2,isnan(prev_selected_t)+gte(t-prev_selected_t,30)+gt(ld(0),0)*gte(t-(ld(0)-1),1)*gte(t-prev_selected_t,2));' +
        'if(ld(2)*gte(t-(ld(0)-1),1),st(0,0));gt(ld(2),0)',
    );
    expect(() => resolveSampleOptions({ settleSec: -1 })).toThrow(Vid2ContextError);
    expect(() => resolveSampleOptions({ sceneThreshold: 1.5 })).toThrow(Vid2ContextError);
    expect(resolveSampleOptions({}).settleSec).toBe(1);
    const args = samplingArgs('/videos/talk.mp4', '/tmp/x', o, 7);
    expect(args).toContain('-filter_complex');
    expect(args.join(' ')).toContain(`scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:flags=area,format=gray[small]`);
    expect(args.filter((a) => a === '-fps_mode')).toHaveLength(2);
    expect(args.at(-1)).toBe('pipe:1');
    expect(samplingArgs('/videos/talk.mp4', '/tmp/x', o, 4)).toContain('-vsync');
  });

  it('downloads URLs with a 480p video-only format and the URL after --', () => {
    const args = downloadArgs('https://example.org/watch?v=1', '/tmp/x', ['--ignore-config']);
    expect(args.slice(-2)).toEqual(['--', 'https://example.org/watch?v=1']);
    expect(args[args.indexOf('-f') + 1]).toBe('bv*[height<=480]/b[height<=480]/wv*/w');
    expect(() => downloadArgs('-o /etc/passwd', '/tmp/x', [])).toThrow(Vid2ContextError);
  });
});

describe('vision rungs', () => {
  it('orders local, free, keyless and honours local-only', () => {
    const env = { OLLAMA_VISION_MODEL: 'qwen2.5vl', GEMINI_API_KEY: 'k1', GEMINI_FALLBACK_KEYS: 'k2' };
    const rungs = nodeProvider.rungs(env);
    expect(rankRungs(rungs, {}, env).map((r) => r.id)).toEqual([
      'visual/ollama/qwen2.5vl',
      'visual/tesseract/eng',
      'visual/gemini/gemini-2.5-flash-lite',
      'visual/gemini#2/gemini-2.5-flash-lite',
      'visual/ovh/Qwen2.5-VL-72B-Instruct',
    ]);
    expect(rankRungs(rungs, { policy: 'local-only' }, env).map((r) => r.id)).toEqual([
      'visual/ollama/qwen2.5vl',
      'visual/tesseract/eng',
    ]);
  });

  it('runs with zero configuration: tesseract, then keyless OVH', () => {
    expect(rankRungs(nodeProvider.rungs({}), {}, {}).map((r) => r.id)).toEqual([
      'visual/tesseract/eng',
      'visual/ovh/Qwen2.5-VL-72B-Instruct',
    ]);
    const off = { TESSERACT_ENABLED: '0', VID2CONTEXT_KEYLESS: '0' };
    expect(rankRungs(nodeProvider.rungs(off), {}, off)).toEqual([]);
    expect(nodeProvider.rungs({ TESSERACT_LANGS: 'ces+eng' }).map((r) => r.id)).toContain('visual/tesseract/ces+eng');
    expect(visualRungs({ OVH_VISION_MODEL: 'Qwen2.5-VL-7B' }).map((r) => r.id)).toContain('visual/ovh/Qwen2.5-VL-7B');
  });

  it('leaves tesseract out of the Workers entry', () => {
    const ids = edgeProvider.rungs({}).map((r) => r.id);
    expect(ids).toContain('visual/ovh/Qwen2.5-VL-72B-Instruct');
    expect(ids.some((id) => id.includes('tesseract'))).toBe(false);
  });

  it('builds a JSON request with the frame as an image data URL', () => {
    const f = frame('030');
    const body = buildVisionBody({ model: 'Qwen2.5-VL-72B-Instruct', jsonMode: true }, f) as {
      model: string;
      response_format: unknown;
      messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[];
    };
    expect(body.model).toBe('Qwen2.5-VL-72B-Instruct');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]?.role).toBe('system');
    const parts = body.messages[1]?.content;
    if (!Array.isArray(parts)) throw new Error('user content should be parts');
    expect(parts[0]?.text).toContain('Frame at 0:30');
    const url = parts[1]?.image_url?.url ?? '';
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(new Uint8Array(Buffer.from(url.split(',')[1] ?? '', 'base64'))).toEqual(f.data);
    expect(clock(3723)).toBe('1:02:03');
  });

  it('reads recorded OVH replies into notes of the right kind', async () => {
    const expected: [FrameSec, VisualNote['kind'], string][] = [
      ['030', 'slide', 'Jak může výzkum přispět ke zlepšení'],
      ['050', 'chart', 'Noví aktivní editoři'],
      ['085', 'code', '{{Infobox - panovník'],
      ['005', 'description', 'Two people'],
      ['112', 'ocr', 'Tento článek je o českém králi'],
    ];
    for (const [s, kind, needle] of expected) {
      resetThrottle();
      const replay = replayFetch([
        {
          method: 'POST',
          url: OVH_CHAT_URL,
          response: { body: text(ovhFile(s)), headers: { 'content-type': 'application/json' } },
        },
      ]);
      const notes = await ovhRung().read(frame(s), testContext({ fetch: replay }));
      expect(notes).toHaveLength(1);
      expect(notes[0]?.kind).toBe(kind);
      expect(notes[0]?.text).toContain(needle);
      expect(notes[0]?.atSec).toBe(Number(s));
      expect(notes[0]?.producer).toBe('visual/ovh/Qwen2.5-VL-72B-Instruct');
      const sent = JSON.parse(String(replay.calls[0]?.body));
      expect(sent.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
      expect(replay.calls[0]?.headers.authorization).toBeUndefined();
    }
  });

  it('keeps code verbatim, including the en dash in the wikitext', () => {
    expect(recordedNote('085').text).toContain('[[1230]]\u2013[[1253]]');
    expect(recordedNote('085').text.split('\n').length).toBeGreaterThan(10);
  });

  it('maps a real 429 to rate-limited with Retry-After', async () => {
    const rec = JSON.parse(text('ovh-qwen2.5-vl-72b.429.json')) as {
      status: number;
      headers: Record<string, string>;
      body: string;
    };
    const replay = replayFetch([{ method: 'POST', url: OVH_CHAT_URL, response: rec }]);
    const err = await ovhRung()
      .read(frame('062'), testContext({ fetch: replay }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('rate-limited');
    expect((err as Vid2ContextError).retryAfterSec).toBe(26);
  });

  it('spaces OVH requests 30 s apart and lets the chain move on meanwhile', async () => {
    const replay = replayFetch([{ method: 'POST', url: OVH_CHAT_URL, response: { body: text(ovhFile('062')) } }]);
    const ctx = testContext({ fetch: replay, env: { TESSERACT_ENABLED: '0' } });
    const rungs = nodeProvider.rungs(ctx.env);
    const first = await runChain('visual', rungs, (r) => r.read(frame('062'), ctx), {}, ctx);
    expect(first.value[0]?.kind).toBe('chart');
    expect(throttleRemainingMs(first.rung.id)).toBeGreaterThan(25_000);
    const second = await runChain('visual', rungs, (r) => r.read(frame('100'), ctx), {}, ctx).catch((e: unknown) => e);
    expect((second as Vid2ContextError).code).toBe('all-rungs-failed');
    const attempts = attemptsOf(second);
    expect(attempts[0]?.reason).toBe('rate-limited');
    expect(onlyRateLimited(attempts)).toBe(true);
    expect(replay.calls).toHaveLength(1);
  });

  it('maps kinds and parses JSON replies', () => {
    expect(mapKind('graph', true)).toBe('chart');
    expect(mapKind('terminal', true)).toBe('code');
    expect(mapKind('something new', true)).toBe('ocr');
    expect(mapKind('slide', false)).toBe('description');
    expect(mapKind('description', true)).toBe('ocr');
    const raw = answerText(JSON.parse(text(ovhFile('030'))));
    expect(parseJsonObject(raw)?.kind).toBe('slide');
    expect(parseJsonObject(`Here it is: ${raw} Done.`)?.kind).toBe('slide');
    expect(parseJsonObject('no json here')).toBeNull();
  });
});

describe('note merging', () => {
  it('merges a repeated code screen into its first occurrence and keeps distinct slides', () => {
    const notes = ['112', '085', '030', '100', '050'].map((s) => recordedNote(s as FrameSec));
    expect(textSimilarity(recordedNote('085').text, recordedNote('100').text)).toBeGreaterThan(0.9);
    const merged = mergeNotes(notes);
    expect(merged.map((n) => n.atSec)).toEqual([30, 50, 85, 112]);
    expect(merged.find((n) => n.atSec === 85)?.kind).toBe('code');
  });

  it('keeps notes whose text changed (the chart read with and without its subtitle line)', () => {
    const a = recordedNote('050');
    const b = recordedNote('062');
    expect(textSimilarity(a.text, b.text)).toBeLessThan(0.9);
    expect(mergeNotes([a, b])).toHaveLength(2);
  });
});

describe('tesseract OCR on real frames (local, no network)', () => {
  it('reads the title slide with the bundled English data', async () => {
    const ctx = testContext({ env: {} });
    const rung = nodeProvider.rungs({}).find((r) => r.service === 'tesseract');
    if (!rung) throw new Error('no tesseract rung');
    try {
      const notes = await rung.read(frame('030'), ctx);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.kind).toBe('ocr');
      expect(notes[0]?.producer).toBe('visual/tesseract/eng');
      const plain = (notes[0]?.text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      expect(plain).toContain('vyzkum');
      expect(plain).toContain('editor');
      expect(plain).toContain('wikimedia');
    } finally {
      await terminateTesseract();
    }
  });

  it('uses the bundled eng directory and never a download for the default language', async () => {
    const { options } = await nodeLangSource(['eng'], testContext());
    expect(String(options.langPath)).toMatch(/@tesseract\.js-data[\\/]eng[\\/]4\.0\.0_best_int$/);
    expect(options.cacheMethod).toBe('none');
  });

  it('drops the low-confidence noise tesseract reads in a photo (recorded blocks)', () => {
    const rec = JSON.parse(text('tesseract-eng.frame-005s.blocks.json')) as { blocks: Parameters<typeof textFromBlocks>[0] };
    // At the default confidence nothing in the speakers' photo survives, so the frame yields no note.
    expect(textFromBlocks(rec.blocks)).toBe('');
    // With no confidence floor, the word rule still drops symbol rows like "[ -" and keeps the subtitle line.
    const all = textFromBlocks(rec.blocks, 0);
    expect(all).toContain('Wikikontdienci 2017');
    expect(all).not.toContain('[ -');
  });
});

describe('runtime split', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    exports: Record<string, string | Record<string, string>>;
  };
  const root = join(import.meta.dirname, '..');

  /** Every module specifier reachable from a source file through relative imports. */
  function reachable(entry: string): { files: string[]; specifiers: string[] } {
    const files = new Set<string>();
    const specifiers = new Set<string>();
    const visit = (file: string) => {
      if (files.has(file)) return;
      files.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? '';
        if (spec.startsWith('.')) visit(join(file, '..', spec));
        else specifiers.add(spec);
      }
    };
    visit(join(root, entry));
    return { files: [...files], specifiers: [...specifiers] };
  }

  it('resolves Workers bundles to the edge entry, Node to the node entry', () => {
    const dot = pkg.exports['.'] as Record<string, string>;
    expect(Object.keys(dot)[0]).toBe('workerd');
    expect(dot.workerd).toBe('./src/edge.ts');
    expect(dot.worker).toBe('./src/edge.ts');
    expect(dot.node).toBe('./src/node-provider.ts');
    expect(pkg.exports['./node']).toBe('./src/node/index.ts');
  });

  it('keeps Node built-ins, tesseract.js and Node-only packages out of the edge entry', () => {
    const { files, specifiers } = reachable('src/edge.ts');
    expect(files.length).toBeGreaterThan(3);
    expect(specifiers.filter((s) => s.startsWith('node:'))).toEqual([]);
    for (const s of ['tesseract.js', '@vid2context/ffmpeg', '@vid2context/provider-ytdlp']) expect(specifiers).not.toContain(s);
    expect(files.some((f) => f.includes(`${join('src', 'node')}`))).toBe(false);
  });

  it('keeps Node built-ins out of the browser entry, which loads tesseract.js lazily', () => {
    const { specifiers } = reachable('src/index.ts');
    expect(specifiers.filter((s) => s.startsWith('node:'))).toEqual([]);
    expect(specifiers).toContain('tesseract.js');
    expect(specifiers).not.toContain('@vid2context/ffmpeg');
  });
});
