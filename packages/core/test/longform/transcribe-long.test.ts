import { existsSync, readFileSync } from 'node:fs';
import {
  type AudioChunk,
  type AudioInput,
  type AudioSplitter,
  clearCooldowns,
  everyRungTooLarge,
  type LongformProgress,
  MemoryKv,
  mp3FramesSplitter,
  normalizeWord,
  Registry,
  type Segment,
  type SttProvider,
  transcribe,
  transcribeLong,
  Vid2ContextError,
} from '@vid2context/core';
import { type RecordedResponse, replayFetch, testContext } from '@vid2context/core/testing';
import sttProvider, { parseVerboseJson } from '@vid2context/provider-stt-openai-compatible';
import { beforeEach, describe, expect, it } from 'vitest';
import { doubleday58, fileRef, fixtureBytes, fixtureDir } from './helpers.ts';

/** Serve the recorded OVH response for the uploaded file name (see test/fixtures/longform/README.md). */
function ovhReplay(rename: (base: string) => string = (b) => b) {
  return replayFetch([
    {
      method: 'POST',
      url: /\/audio\/transcriptions$/,
      response: (call): RecordedResponse => {
        const file = (call.body as FormData).get('file') as File;
        const base = `ovh-${rename(file.name.replace(/\.[^.]+$/, ''))}`;
        for (const status of [200, 413]) {
          const name = status === 200 ? `${base}.json` : `${base}.${status}.json`;
          const url = new URL(name, fixtureDir);
          if (existsSync(url))
            return { status, headers: { 'content-type': 'application/json' }, body: readFileSync(url, 'utf8') };
        }
        throw new Error(`no recorded OVH response for ${file.name}`);
      },
    },
  ]);
}

const registry = new Registry([sttProvider], 'node');
const audio58: AudioInput = { kind: 'bytes', data: doubleday58(), mimeType: 'audio/mpeg', filename: 'doubleday-ch00-58s.mp3' };
const audio90: AudioInput = {
  kind: 'bytes',
  data: fixtureBytes('doubleday-ch00-90s.mp3'),
  mimeType: 'audio/mpeg',
  filename: 'doubleday-ch00-90s.mp3',
};

async function collect(splitter: AudioSplitter, audio: AudioInput, targetSec: number): Promise<AudioChunk[]> {
  const out: AudioChunk[] = [];
  for await (const c of splitter.split(audio, { maxBytes: Number.MAX_SAFE_INTEGER, targetSec, overlapSec: 2 }, testContext()))
    out.push(c);
  return out;
}

function words(segments: Segment[]): string[] {
  return segments
    .flatMap((s) => s.text.split(/\s+/))
    .map(normalizeWord)
    .filter(Boolean);
}

/** 2 * LCS / (|a| + |b|): 1 means the same words in the same order. */
function similarity(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    prev = cur;
  }
  return (2 * (prev[b.length] as number)) / (a.length + b.length);
}

function expectMonotonic(segments: Segment[]) {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] as Segment;
    expect(s.endSec).toBeGreaterThanOrEqual(s.startSec);
    if (i > 0) expect(s.startSec).toBeGreaterThanOrEqual((segments[i - 1] as Segment).startSec);
  }
}

beforeEach(() => clearCooldowns());

describe('transcribeLong on recorded OVH keyless responses', () => {
  it('stitches 3 chunks into a transcript that matches a single pass', async () => {
    const fetch = ovhReplay();
    const progress: LongformProgress[] = [];
    const res = await transcribeLong(
      registry,
      fileRef('doubleday-ch00-58s'),
      audio58,
      { targetSec: 22, kv: new MemoryKv(), onProgress: (p) => progress.push(p) },
      testContext({ fetch }),
    );
    expect(res.chunks).toBe(3);
    expect(fetch.calls).toHaveLength(3);
    expect(res.transcript).toMatchObject({ origin: 'stt', language: 'en', producer: 'stt/ovh/whisper-large-v3-turbo' });
    expect(progress[0]).toMatchObject({ done: 0, total: 3 });
    expect(progress.at(-1)).toMatchObject({ done: 3, total: 3 });
    expect(
      res.attempts.filter((a) => a.outcome === 'ok' && a.id.startsWith('stt/ovh')).map((a) => a.detail?.slice(0, 9)),
    ).toEqual(expect.arrayContaining(['chunk 1/3', 'chunk 2/3', 'chunk 3/3']));

    const segs = res.transcript.segments;
    expectMonotonic(segs);
    expect(segs.at(-1)?.endSec).toBeLessThanOrEqual(58);

    // Word times the rung reported are moved onto the global timeline with their segment.
    for (const seg of segs as (Segment & { words?: { startSec: number; endSec: number }[] })[]) {
      for (const w of seg.words ?? []) {
        expect(w.startSec).toBeGreaterThanOrEqual(seg.startSec - 0.01);
        expect(w.endSec).toBeLessThanOrEqual(seg.endSec + 0.01);
      }
    }

    // Chunk 1 heard nothing in its last seconds and chunk 3 starts in a pause, so neither overlap holds words on both
    // sides: the seams are 'silence', both sides keep every word, and nothing repeats.
    expect(words(segs).join(' ')).toContain('is by mark smith of simpsonville south carolina');
    expect(res.seams.map((s) => s.method)).toEqual(['silence', 'silence']);
    for (const seam of res.seams) {
      const before = words(segs.filter((s) => s.endSec <= seam.cutSec + 0.01))
        .slice(-5)
        .join(' ');
      const after = words(segs.filter((s) => s.startSec >= seam.cutSec - 0.01))
        .slice(0, 8)
        .join(' ');
      expect(after.includes(before)).toBe(false);
    }

    const single = parseVerboseJson(JSON.parse(readFileSync(new URL('ovh-doubleday-ch00-58s.json', fixtureDir), 'utf8')));
    const score = similarity(words(segs), words(single.segments));
    process.stderr.write(`longform 58s: stitched vs single-pass word similarity ${score.toFixed(3)}\n`);
    // Measured 0.885 on these recordings. The stitch drops nothing, but Whisper skipped the LibriVox disclaimer
    // (about 10 s) when it heard chunk 1 alone; the rest matches the single pass.
    expect(score).toBeGreaterThan(0.85);
    const single2and3 = words(single.segments.filter((x) => x.startSec >= 20)).join(' ');
    expect(single2and3).toContain(
      words(segs.filter((x) => x.startSec >= 40))
        .slice(0, 20)
        .join(' '),
    );
  });

  it('re-splits a chunk every rung refuses as too long (OVH keyless caps audio at 60 s)', async () => {
    const fetch = ovhReplay();
    const res = await transcribeLong(
      registry,
      fileRef('doubleday-ch00-90s'),
      audio90,
      { kv: new MemoryKv() },
      testContext({ fetch }),
    );
    expect(res.chunks).toBe(1);
    expect(fetch.calls).toHaveLength(3);
    const resplit = res.attempts.find((a) => a.reason === 'resplit');
    expect(resplit?.detail).toMatch(/splitting to 57\.0s pieces/);
    expect(res.attempts.some((a) => a.reason === 'too-large-413')).toBe(true);
    expectMonotonic(res.transcript.segments);
    expect(res.transcript.segments.at(-1)?.endSec).toBeGreaterThan(80);
    // The two pieces overlap on "to the decisive campaign which freed"; the stitch aligns them and keeps one copy.
    const seam = res.attempts.find((a) => a.id === 'longform/stitch');
    expect(seam).toMatchObject({ reason: 'aligned' });
    expect(Number(/(\d+) words matched/.exec(seam?.detail ?? '')?.[1])).toBeGreaterThanOrEqual(4);
    const text = words(res.transcript.segments).join(' ');
    expect(text.match(/decisive campaign which freed/g)).toHaveLength(1);
  });

  it('resumes after an abort and only sends the unfinished chunks', async () => {
    const kv = new MemoryKv();
    const first = ovhReplay();
    const controller = new AbortController();
    const run1 = transcribeLong(
      registry,
      fileRef('doubleday-ch00-58s'),
      audio58,
      {
        targetSec: 22,
        concurrency: 1,
        kv,
        onProgress: (p) => {
          if (p.done === 1) controller.abort(new Error('stopped after the first chunk'));
        },
      },
      testContext({ fetch: first, signal: controller.signal }),
    );
    await expect(run1).rejects.toThrow('stopped after the first chunk');
    expect(first.calls).toHaveLength(1);
    const keys = await kv.kvList('longform:file:doubleday-ch00-58s:');
    expect(keys.keys).toHaveLength(1);
    expect(keys.keys[0]).toMatch(/^longform:file:doubleday-ch00-58s:[0-9a-f]{64}:0$/);

    const second = ovhReplay();
    const res = await transcribeLong(
      registry,
      fileRef('doubleday-ch00-58s'),
      audio58,
      { targetSec: 22, concurrency: 1, kv },
      testContext({ fetch: second }),
    );
    expect(second.calls).toHaveLength(2);
    expect(res.attempts.filter((a) => a.reason === 'resumed')).toEqual([
      { id: 'stt/ovh/whisper-large-v3-turbo', stage: 'stt', outcome: 'ok', reason: 'resumed', detail: 'chunk 1/3' },
    ]);
    expect(res.transcript.segments.length).toBeGreaterThan(3);
  });

  it('fails with too-large and a hint when no splitter handles the container', async () => {
    const err = await transcribeLong(
      registry,
      fileRef('episode'),
      { kind: 'url', url: 'https://example.org/episode.m4a', mimeType: 'audio/mp4' },
      {},
      testContext(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('too-large');
    expect((err as Vid2ContextError).hint).toMatch(/yt-dlp and ffmpeg providers/);
    expect((err as Vid2ContextError).hint).toMatch(/ffmpeg splitter/);
  });
});

describe('everyRungTooLarge', () => {
  it('ignores rungs that failed on auth, so a bad key does not stop splitting for the rest', () => {
    expect(
      everyRungTooLarge([
        { id: 'stt/cloudflare', stage: 'stt', outcome: 'error', reason: 'auth-401' },
        { id: 'stt/ovh', stage: 'stt', outcome: 'error', reason: 'too-large-413' },
      ]),
    ).toBe(true);
  });

  it('needs at least one too-large refusal, and no other kind of failure', () => {
    expect(everyRungTooLarge([{ id: 'a', stage: 'stt', outcome: 'error', reason: 'auth-401' }])).toBe(false);
    expect(
      everyRungTooLarge([
        { id: 'a', stage: 'stt', outcome: 'error', reason: 'too-large-413' },
        { id: 'b', stage: 'stt', outcome: 'error', reason: 'upstream-500' },
      ]),
    ).toBe(false);
  });
});

describe('pipeline hook', () => {
  it('transcribe() switches to longform when the audio exceeds every rung', async () => {
    // The real OVH rung, declared with a 100 kB upload limit so the 232 kB clip exceeds it.
    const small: SttProvider = {
      ...sttProvider,
      rungs: (env) => sttProvider.rungs(env).map((r) => ({ ...r, maxBytes: 100_000 })),
    };
    const fetch = ovhReplay();
    const res = await transcribe(
      new Registry([small], 'node'),
      fileRef('doubleday-ch00-58s'),
      audio58,
      {},
      testContext({ fetch }),
    );
    expect(fetch.calls).toHaveLength(3);
    expect(res.attempts.find((a) => a.reason === 'split')?.detail).toMatch(/^3 chunks of at most 95000 bytes/);
    expectMonotonic(res.transcript.segments);
  });

  it('transcribe() falls back to longform when every rung answers 413, using the limit the 413 states', async () => {
    // With the 60 s limit known, the 90 s clip goes straight to two pieces under 57 s. They are byte-identical to the
    // pieces the recorder uploaded after its own 413 (it split the single 600 s chunk the same way), so they replay those.
    const direct = await collect(mp3FramesSplitter, audio90, 57);
    const [whole] = await collect(mp3FramesSplitter, audio90, 600);
    const nested = whole ? await collect(mp3FramesSplitter, whole.audio, 57) : [];
    expect(direct.map((c) => c.audio.data)).toEqual(nested.map((c) => c.audio.data));

    const fetch = ovhReplay((name) => name.replace(/^doubleday-ch00-90s-part(\d)$/, 'doubleday-ch00-90s-part1-part$1'));
    const res = await transcribe(registry, fileRef('doubleday-ch00-90s'), audio90, {}, testContext({ fetch }));
    // The single pass (413), then the two pieces: no request is spent rediscovering the limit.
    expect(fetch.calls).toHaveLength(3);
    expect(res.attempts.find((a) => a.reason === 'split')?.detail).toMatch(/^2 chunks/);
    expect(res.transcript.segments.at(-1)?.endSec).toBeGreaterThan(80);
  });
});
