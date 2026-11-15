import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type Segment, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import provider, {
  chooseDevice,
  chooseDtype,
  DEFAULT_MODEL,
  decodeWithFfmpeg,
  mapChunks,
  maxDecodedBytes,
  modelCacheDir,
  modelsFromEnv,
  type PipelineOutput,
  readAudioCapped,
  resolveModelId,
  TURBO_MODEL,
} from '../src/node.ts';

interface Recording {
  model: string;
  device: string;
  durationSec: number;
  detectedLanguage: string;
  output: PipelineOutput;
}

const fixture = (name: string): Recording => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const apolloPath = new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url);
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function expectMonotonic(segments: Segment[], durationSec: number) {
  let prevEnd = 0;
  for (const s of segments) {
    expect(s.startSec).toBeGreaterThanOrEqual(prevEnd);
    expect(s.endSec).toBeGreaterThanOrEqual(s.startSec);
    expect(s.endSec).toBeLessThanOrEqual(durationSec);
    expect(s.text).toBe(s.text.trim());
    expect(s.text.length).toBeGreaterThan(0);
    prevEnd = s.endSec;
  }
}

describe('mapChunks on recorded pipeline output', () => {
  it('maps the 24 s Apollo clip to timed segments', () => {
    const rec = fixture('whisper-base.apollo.json');
    const segments = mapChunks(rec.output, rec.durationSec);
    expect(rec.detectedLanguage).toBe('en');
    expect(segments).toHaveLength(rec.output.chunks?.length ?? 0);
    expect(segments.map((s) => s.text).join(' ')).toMatch(/small step/i);
    expect(segments[0]).toMatchObject({ startSec: 0 });
    expectMonotonic(segments, rec.durationSec);
  });

  it('keeps absolute times across 30 s chunk windows on the 72 s recording', () => {
    const rec = fixture('whisper-base.apollo-x3.json');
    const segments = mapChunks(rec.output, rec.durationSec);
    expectMonotonic(segments, rec.durationSec);
    // The clip repeats every ~24.1 s; "one small step"/"small spare" is spoken once per copy.
    const hits = segments.filter((s) => /one small (step|spare)/i.test(s.text));
    expect(hits).toHaveLength(3);
    const copyOf = (s: Segment) => Math.floor(s.startSec / (rec.durationSec / 3));
    expect(hits.map(copyOf)).toEqual([0, 1, 2]);
    // The phrase ends at the same point in each copy (within model jitter), so window offsets were applied.
    const ends = hits.map((s) => s.endSec - copyOf(s) * (rec.durationSec / 3));
    for (const e of ends) expect(Math.abs(e - (ends[0] ?? 0))).toBeLessThan(1.5);
    expect(segments.at(-1)?.endSec ?? 0).toBeGreaterThan(60);
  });

  it('falls back to the whole text as one segment when the pipeline returns no chunks', () => {
    const rec = fixture('whisper-base.apollo.json');
    const segments = mapChunks({ text: rec.output.text }, rec.durationSec);
    expect(segments).toEqual([{ startSec: 0, endSec: Math.round(rec.durationSec * 1000) / 1000, text: rec.output.text.trim() }]);
  });
});

describe('env and rungs', () => {
  it('is enabled only by TRANSFORMERS_STT_MODEL', () => {
    const [rung] = provider.rungs({});
    expect(rung?.id).toBe(`stt/transformers/${DEFAULT_MODEL}`);
    expect(rung?.isEnabled?.({})).toBe(false);
    expect(rung?.isEnabled?.({ TRANSFORMERS_DEVICE: 'cpu' })).toBe(false);
    expect(rung?.isEnabled?.({ TRANSFORMERS_STT_MODEL: 'whisper-base' })).toBe(true);
    expect(rung?.isEnabled?.({ TRANSFORMERS_STT_MODEL: 'whisper-small' })).toBe(false);
  });

  it('builds one local rung per configured model, short names expanded', () => {
    const rungs = provider.rungs({
      TRANSFORMERS_STT_MODEL: 'whisper-small, onnx-community/whisper-large-v3-turbo,whisper-base.en',
    });
    expect(rungs.map((r) => r.id)).toEqual([
      'stt/transformers/onnx-community/whisper-small',
      `stt/transformers/${TURBO_MODEL}`,
      'stt/transformers/onnx-community/whisper-base.en',
    ]);
    for (const r of rungs) {
      expect(r.tier).toBe('local');
      expect(r.service).toBe('transformers');
      expect(r.provider).toBe('stt-transformers');
      expect(r.requires).toEqual(['TRANSFORMERS_STT_MODEL']);
      expect(r.capabilities).toContain('segments');
      expect(
        r.isEnabled?.({ TRANSFORMERS_STT_MODEL: 'whisper-small, onnx-community/whisper-large-v3-turbo,whisper-base.en' }),
      ).toBe(true);
    }
    expect(rungs[0]?.capabilities).toEqual(['segments', 'language-detect', 'translate']);
    // large-v3-turbo was trained without translation; English-only models detect nothing.
    expect(rungs[1]?.capabilities).toEqual(['segments', 'language-detect']);
    expect(rungs[2]?.capabilities).toEqual(['segments']);
    expect(rungs[1]?.quality).toBeGreaterThan(rungs[0]?.quality ?? 0);
  });

  it('parses model lists', () => {
    expect(modelsFromEnv({ TRANSFORMERS_STT_MODEL: ' ' })).toEqual([]);
    expect(modelsFromEnv({ TRANSFORMERS_STT_MODEL: 'whisper-base,whisper-base' })).toEqual([DEFAULT_MODEL]);
    expect(resolveModelId('someone/custom-whisper')).toBe('someone/custom-whisper');
  });

  it('puts the model cache under VID2CONTEXT_HOME or ./.vid2context', () => {
    expect(modelCacheDir({}, '/work')).toBe('/work/.vid2context/models/transformers');
    expect(modelCacheDir({ VID2CONTEXT_HOME: '/data/v2c' }, '/work')).toBe('/data/v2c/models/transformers');
    expect(modelCacheDir({ VID2CONTEXT_HOME: 'rel' }, '/work')).toBe('/work/rel/models/transformers');
  });
});

describe('device and dtype selection', () => {
  it('uses CPU in Node, WebGPU or WASM in the browser', () => {
    expect(chooseDevice('node', undefined, false)).toBe('cpu');
    expect(chooseDevice('node', 'auto', true)).toBe('cpu');
    expect(chooseDevice('browser', undefined, true)).toBe('webgpu');
    expect(chooseDevice('browser', undefined, false)).toBe('wasm');
    expect(chooseDevice('browser', 'WASM', true)).toBe('wasm');
    expect(chooseDevice('node', 'cuda', false)).toBe('cuda');
  });

  it('rejects devices the runtime cannot use', () => {
    expect(() => chooseDevice('browser', 'cuda', true)).toThrow(Vid2ContextError);
    expect(() => chooseDevice('node', 'wasm', false)).toThrow(/not supported on node/);
  });

  it('runs small models at full precision on CPU and WASM', () => {
    expect(chooseDtype('cpu', DEFAULT_MODEL)).toEqual({ encoder_model: 'fp32', decoder_model_merged: 'fp32' });
    expect(chooseDtype('wasm', 'onnx-community/whisper-small')).toEqual({ encoder_model: 'fp32', decoder_model_merged: 'fp32' });
    expect(chooseDtype('cpu', TURBO_MODEL)).toEqual({ encoder_model: 'q8', decoder_model_merged: 'q4' });
    expect(chooseDtype('webgpu', DEFAULT_MODEL)).toEqual({ encoder_model: 'fp32', decoder_model_merged: 'q4' });
    expect(chooseDtype('webgpu', TURBO_MODEL)).toEqual({ encoder_model: 'fp16', decoder_model_merged: 'q4' });
  });

  it('honours TRANSFORMERS_DTYPE', () => {
    expect(chooseDtype('cpu', DEFAULT_MODEL, 'fp32')).toBe('fp32');
    expect(chooseDtype('cpu', DEFAULT_MODEL, 'encoder=fp16, decoder=q4')).toEqual({
      encoder_model: 'fp16',
      decoder_model_merged: 'q4',
    });
    expect(() => chooseDtype('cpu', DEFAULT_MODEL, 'fp64')).toThrow(/unknown dtype/);
    expect(() => chooseDtype('cpu', DEFAULT_MODEL, 'encoder=q8')).toThrow(/expected encoder/);
  });
});

describe('runtime split', () => {
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const imports = (code: string) => [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

  it('keeps Node built-ins out of the browser entry and the shared core', () => {
    for (const f of ['browser.ts', 'index.ts']) {
      const found = imports(src(f));
      expect(found.length).toBeGreaterThan(0);
      for (const spec of found) {
        expect(spec).not.toMatch(/^node:/);
        expect(['child_process', 'fs', 'fs/promises', 'path', 'os']).not.toContain(spec);
        if (spec?.startsWith('.')) expect(spec).toBe('./index.ts');
      }
    }
  });

  it('maps the browser condition to the browser entry', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['.']).toEqual({ browser: './src/browser.ts', default: './src/node.ts' });
    expect(pkg.vid2context.runtimes).toEqual(['node', 'browser']);
  });
});

describe.skipIf(!hasFfmpeg)('ffmpeg decoding (local, no network)', () => {
  it('decodes the Apollo mp3 to 16 kHz mono float samples', async () => {
    const data = new Uint8Array(readFileSync(apolloPath));
    const samples = await decodeWithFfmpeg({ kind: 'bytes', data, mimeType: 'audio/mpeg', filename: 'a.mp3' }, testContext());
    expect(samples.length / 16000).toBeCloseTo(24.12, 1);
    expect(Math.max(...samples.subarray(16000 * 5, 16000 * 10))).toBeGreaterThan(0.01);
  });

  it('stops ffmpeg and throws a timeout instead of waiting forever', async () => {
    const data = new Uint8Array(readFileSync(apolloPath));
    const err = await decodeWithFfmpeg({ kind: 'bytes', data, mimeType: 'audio/mpeg', filename: 'a.mp3' }, testContext(), {
      timeoutMs: 1,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err.code).toBe('timeout');
    expect(err.hint).toBeTruthy();
  });

  it('stops ffmpeg once the decoded samples pass the byte cap', async () => {
    const data = new Uint8Array(readFileSync(apolloPath));
    const err = await decodeWithFfmpeg({ kind: 'bytes', data, mimeType: 'audio/mpeg', filename: 'a.mp3' }, testContext(), {
      maxBytes: 16000 * 4 * 2,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err.code).toBe('too-large');
    expect(err.hint).toMatch(/TRANSFORMERS_MAX_DECODED_MB/);
  });

  it('reads the decoded cap from TRANSFORMERS_MAX_DECODED_MB', () => {
    expect(maxDecodedBytes({ TRANSFORMERS_MAX_DECODED_MB: '2' })).toBe(2 * 1024 * 1024);
    expect(maxDecodedBytes({})).toBe(1024 * 1024 * 1024);
    expect(maxDecodedBytes({ TRANSFORMERS_MAX_DECODED_MB: '-1' })).toBe(1024 * 1024 * 1024);
  });

  it('reports a missing ffmpeg with a hint', async () => {
    const ctx = testContext({ env: { FFMPEG_PATH: '/nonexistent/ffmpeg' } });
    const err = await decodeWithFfmpeg(
      { kind: 'bytes', data: new Uint8Array(4), mimeType: 'audio/mpeg', filename: 'a.mp3' },
      ctx,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err.code).toBe('no-provider');
    expect(err.hint).toMatch(/FFMPEG_PATH/);
  });
});

describe.skipIf(!process.env.LIVE)('live: Whisper on onnxruntime-node', () => {
  const home = mkdtempSync(join(tmpdir(), 'v2c-home-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('downloads whisper-base into VID2CONTEXT_HOME and transcribes the Apollo clip offline', async () => {
    const env = { TRANSFORMERS_STT_MODEL: 'whisper-base', VID2CONTEXT_HOME: home, PATH: process.env.PATH };
    const ctx = createContext({ runtime: 'node', env });
    const rung = provider.rungs(env).find((r) => r.isEnabled?.(env));
    expect(rung?.id).toBe(`stt/transformers/${DEFAULT_MODEL}`);
    const data = new Uint8Array(readFileSync(apolloPath));
    const result = await rung?.transcribe({ kind: 'bytes', data, mimeType: 'audio/mpeg', filename: 'apollo.mp3' }, {}, ctx);
    expect(result?.language).toBe('en');
    expect(result?.segments.map((s) => s.text).join(' ')).toMatch(/small step/i);
    expectMonotonic(result?.segments ?? [], 24.2);
    const cached = spawnSync('find', [join(home, 'models', 'transformers'), '-name', '*.onnx']).stdout.toString();
    expect(cached).toMatch(/encoder_model\.onnx/);
    expect(cached).toMatch(/decoder_model_merged\.onnx/);
  }, 300_000);
});

describe('readAudioCapped', () => {
  // The shared public-domain Apollo 11 clip (145,412 bytes).
  const mp3 = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url)));

  it('returns the whole file under the cap', async () => {
    const data = await readAudioCapped(new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }), {});
    expect(data).toEqual(mp3);
  });

  it('refuses a declared size over VID2CONTEXT_MAX_MEDIA_MB', async () => {
    const res = new Response(mp3, { headers: { 'content-length': String(mp3.byteLength) } });
    await expect(readAudioCapped(res, { VID2CONTEXT_MAX_MEDIA_MB: '0.1' })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('stops a stream without a length once it passes the cap', async () => {
    const res = new Response(new Blob([mp3]).stream());
    await expect(readAudioCapped(res, { VID2CONTEXT_MAX_MEDIA_MB: '0.1' })).rejects.toMatchObject({
      code: 'too-large',
      hint: expect.stringMatching(/VID2CONTEXT_MAX_MEDIA_MB/),
    });
  });
});
