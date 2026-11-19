import { existsSync, readFileSync } from 'node:fs';
import {
  type Attempt,
  type AudioBytes,
  type AudioChunk,
  type AudioInput,
  type AudioSplitter,
  audioDurationSec,
  clearCooldowns,
  cooldownReason,
  everyRungTooLarge,
  exceedsEveryRung,
  hasDecoderLoop,
  type LongformProgress,
  loopRetryTargetSec,
  MemoryKv,
  mp3FramesSplitter,
  normalizeWord,
  Registry,
  type Segment,
  type SttProvider,
  transcribe,
  transcribeLong,
  Vid2ContextError,
  waitHelps,
} from '@vid2context/core';
import { type RecordedResponse, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import sttProvider, { parseVerboseJson } from '@vid2context/provider-stt-openai-compatible';
import { beforeEach, describe, expect, it } from 'vitest';
import { doubleday58, fileRef, fixtureBytes, fixtureDir } from './helpers.ts';

/**
 * Serve the recorded OVH response for the uploaded file name (see test/fixtures/longform/README.md).
 * `before` routes are matched first (another service's recorded answer).
 */
function ovhReplay(rename: (base: string) => string = (b) => b, before: Route[] = []) {
  return replayFetch([
    ...before,
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

/** Groq's recorded answer to a bad key (providers/stt-openai-compatible/test/fixtures/README.md). */
function groq401(): RecordedResponse {
  const url = new URL('../../../../providers/stt-openai-compatible/test/fixtures/groq-401-no-key.response.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as RecordedResponse;
}

/** The recorded keyless OVH loop: one segment of "ギ" 19 times (see test/fixtures/clean/README.md). */
const LOOP_BODY = readFileSync(new URL('../fixtures/clean/ovh-whisper-loop.verbose.json', import.meta.url), 'utf8');

/** Like ovhReplay, but uploads whose base name `loops` accepts get the recorded loop instead. */
function ovhReplayLooping(loops: (base: string, nth: number) => boolean) {
  const seen = new Map<string, number>();
  return replayFetch([
    {
      method: 'POST',
      url: /\/audio\/transcriptions$/,
      response: (call): RecordedResponse => {
        const file = (call.body as FormData).get('file') as File;
        const base = file.name.replace(/\.[^.]+$/, '');
        const nth = (seen.get(base) ?? 0) + 1;
        seen.set(base, nth);
        if (loops(base, nth)) return { status: 200, headers: { 'content-type': 'application/json' }, body: LOOP_BODY };
        const url = new URL(`ovh-${base}.json`, fixtureDir);
        if (!existsSync(url)) throw new Error(`no recorded OVH response for ${file.name}`);
        return { status: 200, headers: { 'content-type': 'application/json' }, body: readFileSync(url, 'utf8') };
      },
    },
  ]);
}

const registry = new Registry([sttProvider], 'node');
/** The real OVH rung without its declared 60 s cap, so the learn-the-limit-from-a-413 path runs. */
const learning = new Registry(
  [{ ...sttProvider, rungs: (env) => sttProvider.rungs(env).map((r) => ({ ...r, maxDurationSec: undefined })) }],
  'node',
);
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
      learning,
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

  it('plans pieces under the 60 s cap OVH declares, so no upload is refused', async () => {
    // Same two 57 s pieces the 413 test ends with (byte-identical, see the pipeline hook test), named part1 and part2.
    const fetch = ovhReplay((name) => name.replace(/^doubleday-ch00-90s-part(\d)$/, 'doubleday-ch00-90s-part1-part$1'));
    const res = await transcribeLong(
      registry,
      fileRef('doubleday-ch00-90s'),
      audio90,
      { kv: new MemoryKv() },
      testContext({ fetch }),
    );
    expect(fetch.calls).toHaveLength(2);
    expect(res.chunks).toBe(2);
    expect(res.attempts.some((a) => a.reason?.startsWith('too-large'))).toBe(false);
    expect(res.attempts.some((a) => a.reason === 'resplit')).toBe(false);
    expect(res.transcript.segments.at(-1)?.endSec).toBeGreaterThan(80);
    expect(
      words(res.transcript.segments)
        .join(' ')
        .match(/decisive campaign which freed/g),
    ).toHaveLength(1);
  });

  it('sends a looped chunk again in two halves and keeps the real speech', async () => {
    // Chunk 2 first answers with the recorded decoder loop; its two halves answer with what OVH really heard.
    const fetch = ovhReplayLooping((base, nth) => base === 'doubleday-ch00-58s-part2' && nth === 1);
    const res = await transcribeLong(
      registry,
      fileRef('doubleday-ch00-58s'),
      audio58,
      { targetSec: 22, kv: new MemoryKv() },
      testContext({ fetch }),
    );
    expect(fetch.calls).toHaveLength(5);
    expect(res.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'repetition-loop', detail: expect.stringMatching(/^chunk 2\/3: /) }),
        expect.objectContaining({ reason: 'loop-resplit', detail: expect.stringMatching(/^chunk 2\/3: splitting 21\.\ds/) }),
      ]),
    );
    expect(res.attempts.some((a) => a.reason === 'loop-kept')).toBe(false);
    expect(res.attempts.some((a) => a.id === 'clean/repetition-guard')).toBe(false);
    const text = words(res.transcript.segments).join(' ');
    expect(text).not.toContain('ギ');
    expect(text).toContain('campaigns of the civil war');
    expect(text).toContain('commanding the i corps at gettysburg');
    expect(hasDecoderLoop(res.transcript.segments)).toBe(false);
    expectMonotonic(res.transcript.segments);
    expect(res.transcript.segments.at(-1)?.endSec).toBeLessThanOrEqual(58);
  });

  it('keeps a chunk whose halves still loop with the loop cut back, and says the speech is missing', async () => {
    const fetch = ovhReplayLooping((base) => base.startsWith('doubleday-ch00-58s-part2'));
    const res = await transcribeLong(
      registry,
      fileRef('doubleday-ch00-58s'),
      audio58,
      { targetSec: 22, kv: new MemoryKv() },
      testContext({ fetch }),
    );
    // 3 chunks, then chunk 2's two halves; a half is never split again for a loop.
    expect(fetch.calls).toHaveLength(5);
    expect(res.attempts.filter((a) => a.reason === 'loop-kept').map((a) => a.detail?.slice(0, 18))).toEqual([
      'chunk 2/3 part 1/2',
      'chunk 2/3 part 2/2',
    ]);
    expect(hasDecoderLoop(res.transcript.segments)).toBe(false);
    // Chunks 1 and 3 are untouched; chunk 2's speech ("This reading is by Mark Smith...") is the part reported missing.
    const text = words(res.transcript.segments).join(' ');
    expect(text).toContain('preface to chancellorsville and gettysburg');
    expect(text).toContain('decisive campaign which freed the northern states');
    expect(text).not.toContain('mark smith');
  });

  it('with splitLoops false, only asks the other rungs and then cuts the loop back', async () => {
    const fetch = ovhReplayLooping((base) => base === 'doubleday-ch00-58s-part2');
    const res = await transcribeLong(
      registry,
      fileRef('doubleday-ch00-58s'),
      audio58,
      { targetSec: 22, kv: new MemoryKv(), splitLoops: false },
      testContext({ fetch }),
    );
    expect(fetch.calls).toHaveLength(3);
    expect(res.attempts.some((a) => a.reason === 'loop-resplit')).toBe(false);
    expect(res.attempts.filter((a) => a.reason === 'loop-kept')).toHaveLength(1);
    expect(hasDecoderLoop(res.transcript.segments)).toBe(false);
  });

  it('re-splits for OVH when the rung the chunks were planned for has a bad key, without waiting out its cooldown', async () => {
    // Seen live on 2026-11-19 with a bad Cloudflare key: chunks are planned for the first-ranked rungs, so the one
    // 90 s chunk fits only the keyed rung, which answers 401 and cools down for 10 minutes. Groq's recorded 401 plays
    // that rung here; concurrency 1 makes it the only rung the plan looks at.
    const fetch = ovhReplay((name) => name, [{ method: 'POST', url: /^https:\/\/api\.groq\.com\//, response: groq401() }]);
    const env = { GROQ_API_KEY: 'gsk-value-for-tests' };
    const res = await transcribeLong(
      registry,
      fileRef('doubleday-ch00-90s'),
      audio90,
      { kv: new MemoryKv(), concurrency: 1 },
      testContext({ fetch, env }),
    );
    expect(res.chunks).toBe(1);
    expect(res.attempts.find((a) => a.reason === 'resplit')?.detail).toBe(
      'chunk 1/1: the rungs that take 90.1s failed, and the rest take at most 60s; splitting to 57.0s pieces',
    );
    expect(res.attempts.some((a) => a.reason === 'rate-limit-wait')).toBe(false);
    expect(fetch.calls.filter((c) => c.url.includes('api.groq.com'))).toHaveLength(1);
    expect(res.transcript.producer).toBe('stt/ovh/whisper-large-v3-turbo');
    expect(res.transcript.segments.at(-1)?.endSec).toBeGreaterThan(80);
    const groq = registry.sttRungs(env).find((r) => r.service === 'groq');
    expect(groq && cooldownReason(groq, env)).toBe('auth');
  });

  it('re-splits every chunk when concurrent chunks hit the bad-key case at the same time', async () => {
    // Found in review: two chunks failing together raced on the learned limit, and the second rethrew, failing the
    // whole job. Two Groq keys (both answering Groq's recorded 401) start the chunks; the real OVH rung, copied with
    // a 30 s cap, is the only rung left, so both 45 s chunks must be split. The OVH bodies are real recordings
    // reused by piece number: this test checks scheduling, not words.
    const capped = new Registry(
      [
        {
          ...sttProvider,
          rungs: (env) => sttProvider.rungs(env).map((r) => (r.service === 'ovh' ? { ...r, maxDurationSec: 30 } : r)),
        },
      ],
      'node',
    );
    const fetch = ovhReplay(
      (name) => name.replace(/^doubleday-ch00-90s-part\d-part(\d)$/, 'doubleday-ch00-58s-part$1'),
      [{ method: 'POST', url: /^https:\/\/api\.groq\.com\//, response: groq401() }],
    );
    const env = { GROQ_API_KEY: 'gsk-value-for-tests', GROQ_FALLBACK_KEYS: 'gsk-second-value-for-tests' };
    const res = await transcribeLong(
      capped,
      fileRef('doubleday-ch00-90s'),
      audio90,
      { kv: new MemoryKv(), concurrency: 2, targetSec: 50 },
      testContext({ fetch, env }),
    );
    expect(res.chunks).toBe(2);
    const resplits = res.attempts.filter((a) => a.reason === 'resplit').map((a) => a.detail?.slice(0, 9));
    expect(resplits.sort()).toEqual(['chunk 1/2', 'chunk 2/2']);
    expect(res.transcript.producer).toBe('stt/ovh/whisper-large-v3-turbo');
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

  it('counts a rung skipped up front for its declared limit as a too-large refusal', () => {
    expect(
      everyRungTooLarge([
        { id: 'stt/ovh', stage: 'stt', outcome: 'skipped', reason: 'too-large', detail: '90.1s > 60s' },
        { id: 'stt/cloudflare', stage: 'stt', outcome: 'error', reason: 'auth-401' },
      ]),
    ).toBe(true);
    expect(everyRungTooLarge([{ id: 'stt/ovh', stage: 'stt', outcome: 'skipped', reason: 'cooldown' }])).toBe(false);
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

describe('waitHelps', () => {
  const ovh429: Attempt = { id: 'stt/ovh', stage: 'stt', outcome: 'error', reason: 'rate-limited-429' };
  const cfAuth: Attempt = { id: 'stt/cf', stage: 'stt', outcome: 'error', reason: 'auth-401' };
  const cfCooling: Attempt = { id: 'stt/cf', stage: 'stt', outcome: 'skipped', reason: 'cooldown' };
  const ovhCooling: Attempt = { id: 'stt/ovh', stage: 'stt', outcome: 'skipped', reason: 'cooldown' };
  const causes = (map: Record<string, string>) => (id: string) => map[id];

  it('waits for a rate-limited rung even while rungs with bad keys are cooling down (seen live 2026-11-19)', () => {
    expect(waitHelps([cfCooling, ovh429], causes({ 'stt/cf': 'auth' }))).toBe(true);
    expect(waitHelps([cfCooling, ovhCooling], causes({ 'stt/cf': 'auth', 'stt/ovh': 'rate-limited' }))).toBe(true);
    expect(waitHelps([cfAuth, ovh429], causes({}))).toBe(true);
  });

  it('does not wait when only rungs with bad keys are left', () => {
    expect(waitHelps([cfCooling], causes({ 'stt/cf': 'auth' }))).toBe(false);
    expect(waitHelps([cfAuth], causes({}))).toBe(false);
    expect(waitHelps([], causes({}))).toBe(false);
  });

  it('does not wait when a rung failed in a way waiting cannot fix', () => {
    const bad: Attempt = { id: 'stt/x', stage: 'stt', outcome: 'error', reason: 'upstream-500' };
    expect(waitHelps([ovh429, bad], causes({}))).toBe(false);
  });

  it('counts a cooldown that already ended as coming back', () => {
    expect(waitHelps([ovhCooling], causes({}))).toBe(true);
  });
});

describe('loop helpers', () => {
  it('hasDecoderLoop is true for the recorded loop and false for real transcripts with natural repeats', () => {
    const loop = parseVerboseJson(JSON.parse(LOOP_BODY));
    expect(hasDecoderLoop(loop.segments)).toBe(true);
    const clean = parseVerboseJson(JSON.parse(readFileSync(new URL('ovh-doubleday-ch00-58s.json', fixtureDir), 'utf8')));
    expect(hasDecoderLoop(clean.segments)).toBe(false);
    expect(hasDecoderLoop([{ startSec: 0, endSec: 2, text: 'yes yes, really really well' }])).toBe(false);
  });

  it('loopRetryTargetSec splits a piece into exactly two overlapping parts', async () => {
    const [, second] = await collect(mp3FramesSplitter, audio58, 22);
    for (const [audio, sec] of [
      [audio58, 58],
      [audio90, 90.1],
      [second?.audio as AudioInput, second?.durationSec as number],
    ] as const) {
      const parts = await collect(mp3FramesSplitter, audio, loopRetryTargetSec(sec, 2));
      expect(parts).toHaveLength(2);
    }
  });

  it('audioDurationSec measures MP3 and WAV, and says unknown for anything else', () => {
    expect(audioDurationSec(audio58 as AudioBytes)).toBeCloseTo(58, 0);
    expect(audioDurationSec(audio90 as AudioBytes)).toBeCloseTo(90.1, 1);
    const wav = {
      kind: 'bytes' as const,
      data: fixtureBytes('apollo11-small-step.wav'),
      mimeType: 'audio/wav',
      filename: 'a.wav',
    };
    expect(audioDurationSec(wav)).toBeGreaterThan(20);
    // MP3 bytes under a WAV name: the WAV header does not parse, so the length is unknown rather than wrong.
    expect(audioDurationSec({ ...(audio58 as AudioBytes), filename: 'mislabelled.wav', mimeType: 'audio/wav' })).toBeUndefined();
    expect(audioDurationSec({ ...(audio58 as AudioBytes), durationSec: 12.5 })).toBe(12.5);
  });

  it('exceedsEveryRung counts a known duration against the 60 s OVH declares', () => {
    const ctx = testContext();
    expect(exceedsEveryRung(registry, { ...audio58, durationSec: 58 } as AudioInput, undefined, ctx)).toBe(false);
    expect(exceedsEveryRung(registry, { ...audio90, durationSec: 90.1 } as AudioInput, undefined, ctx)).toBe(true);
    // Unknown length: the bytes alone decide, and 360 kB is under the 10 MB cap.
    expect(exceedsEveryRung(registry, audio90, undefined, ctx)).toBe(false);
  });
});

describe('pipeline hook', () => {
  it('transcribe() sends audio of known length over 60 s straight to longform, with no refused upload', async () => {
    const fetch = ovhReplay((name) => name.replace(/^doubleday-ch00-90s-part(\d)$/, 'doubleday-ch00-90s-part1-part$1'));
    const res = await transcribe(
      registry,
      fileRef('doubleday-ch00-90s'),
      { ...audio90, durationSec: 90.1 } as AudioInput,
      {},
      testContext({ fetch }),
    );
    expect(fetch.calls).toHaveLength(2);
    expect(res.attempts.some((a) => a.reason?.startsWith('too-large-'))).toBe(false);
    expect(res.transcript.segments.at(-1)?.endSec).toBeGreaterThan(80);
  });

  it('transcribe() goes to longform when OVH is skipped for length and the only other rung fails on auth', async () => {
    // Seen live on 2026-11-19: a rung with a bad key answered 401 and OVH was skipped for the 60 s it declares, so
    // nothing reached the long-audio path. Groq's recorded 401 stands in for the bad key.
    const fetch = ovhReplay(
      (name) => name.replace(/^doubleday-ch00-90s-part(\d)$/, 'doubleday-ch00-90s-part1-part$1'),
      [{ method: 'POST', url: /^https:\/\/api\.groq\.com\//, response: groq401() }],
    );
    const res = await transcribe(
      registry,
      fileRef('doubleday-ch00-90s'),
      { ...audio90, durationSec: 90.1 } as AudioInput,
      {},
      testContext({ fetch, env: { GROQ_API_KEY: 'gsk-value-for-tests' } }),
    );
    expect(res.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'stt/ovh/whisper-large-v3-turbo', outcome: 'skipped', reason: 'too-large' }),
        expect.objectContaining({ id: 'stt/groq/whisper-large-v3-turbo', outcome: 'error', reason: 'auth-401' }),
      ]),
    );
    expect(res.transcript.producer).toBe('stt/ovh/whisper-large-v3-turbo');
    expect(res.transcript.segments.at(-1)?.endSec).toBeGreaterThan(80);
  });

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
