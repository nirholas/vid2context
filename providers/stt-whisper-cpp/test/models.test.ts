import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import type { Hardware } from '../src/hardware.ts';
import {
  downloadVerified,
  isEnglishOnly,
  MODEL_SIZES,
  modelNameOf,
  parseModelIndex,
  qualityOf,
  recommendModel,
  resolveModel,
} from '../src/models.ts';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe('model names', () => {
  it('resolves catalog names into the models directory', () => {
    const m = resolveModel('large-v3-turbo-q5_0', { VID2CONTEXT_HOME: '/data/v2c' });
    expect(m).toEqual({
      name: 'large-v3-turbo-q5_0',
      path: '/data/v2c/models/whisper/ggml-large-v3-turbo-q5_0.bin',
      known: true,
    });
  });

  it('accepts absolute paths and derives the rung name', () => {
    const m = resolveModel('/opt/models/ggml-base.en.bin', {});
    expect(m).toEqual({ name: 'base.en', path: '/opt/models/ggml-base.en.bin', known: false });
    expect(modelNameOf('/opt/models/ggml-base.en.bin')).toBe('base.en');
    expect(modelNameOf('small')).toBe('small');
  });

  it('rejects names that could escape the models directory', () => {
    expect(() => resolveModel('a b', {})).toThrow(/Invalid whisper.cpp model name/);
  });

  it('knows English-only and quality', () => {
    expect(isEnglishOnly('base.en')).toBe(true);
    expect(isEnglishOnly('small.en-q5_1')).toBe(true);
    expect(isEnglishOnly('large-v3-turbo')).toBe(false);
    expect(qualityOf('tiny.en')).toBe(1);
    expect(qualityOf('large-v3-turbo-q5_0')).toBe(4);
    expect(qualityOf('large-v3')).toBe(5);
  });
});

describe('Hugging Face index (recorded tree API, 2026-11-14)', () => {
  const index = parseModelIndex(JSON.parse(readFileSync(fixture('hf-tree-main.json'), 'utf8')));

  it('reads the sha256 the repository publishes as the LFS oid', () => {
    // Verified locally: sha256sum ggml-tiny.bin and ggml-base.en.bin match these.
    expect(index.get('ggml-tiny.bin')).toEqual({
      size: 77691713,
      sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    });
    expect(index.get('ggml-base.en.bin')?.sha256).toBe('a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002');
    expect(index.has('README.md')).toBe(false);
  });

  it('has every catalog model with the catalog size', () => {
    for (const [name, size] of Object.entries(MODEL_SIZES)) {
      expect(index.get(`ggml-${name}.bin`)?.size, name).toBe(size);
    }
  });
});

describe('recommendModel', () => {
  const vm = JSON.parse(readFileSync(fixture('hardware-gcp-vm.json'), 'utf8')) as Hardware;

  it('picks small on this many-core CPU VM, small.en for English', () => {
    expect(recommendModel(vm)).toBe('small');
    expect(recommendModel(vm, { language: 'en-US' })).toBe('small.en');
  });

  it('picks large-v3-turbo for a 6 GB NVIDIA GPU or Apple Silicon, not with --force-cpu', () => {
    expect(recommendModel({ ...vm, gpu: { vendor: 'nvidia', vramMb: 6144, cuda: true } })).toBe('large-v3-turbo');
    expect(recommendModel({ ...vm, gpu: { vendor: 'apple', metal: true } })).toBe('large-v3-turbo');
    expect(recommendModel({ ...vm, gpu: { vendor: 'apple', metal: true } }, { forceCpu: true })).toBe('small');
  });

  it('picks base on a small CPU', () => {
    expect(recommendModel({ ...vm, cpuCores: 4, memoryMb: 4096 }, { language: 'en' })).toBe('base.en');
  });
});

describe('downloadVerified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-cpp-dl-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Real bytes: the recorded whisper-cli output, served as the download body.
  const body = new Uint8Array(readFileSync(fixture('cli-base.en-apollo.json')));
  const sha256 = createHash('sha256').update(body).digest('hex');
  const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-x.bin';

  it('writes the file only after the checksum matches', async () => {
    const dest = join(dir, 'full.bin');
    const fetch = replayFetch([{ url, response: { body } }]);
    await downloadVerified(url, dest, { sha256, size: body.byteLength }, testContext({ fetch }));
    expect(readFileSync(dest)).toEqual(Buffer.from(body));
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('resumes a partial file with a Range request', async () => {
    const dest = join(dir, 'resume.bin');
    writeFileSync(`${dest}.part`, body.subarray(0, 100));
    const fetch = replayFetch([{ url, response: { status: 206, body: body.subarray(100) } }]);
    await downloadVerified(url, dest, { sha256, size: body.byteLength }, testContext({ fetch }));
    expect(fetch.calls[0]?.headers.range).toBe('bytes=100-');
    expect(readFileSync(dest)).toEqual(Buffer.from(body));
  });

  it('restarts when the server ignores the Range header', async () => {
    const dest = join(dir, 'restart.bin');
    writeFileSync(`${dest}.part`, body.subarray(0, 50));
    const fetch = replayFetch([{ url, response: { status: 200, body } }]);
    await downloadVerified(url, dest, { sha256, size: body.byteLength }, testContext({ fetch }));
    expect(readFileSync(dest)).toEqual(Buffer.from(body));
  });

  it('deletes the partial file and leaves nothing behind on a mismatch', async () => {
    const dest = join(dir, 'bad.bin');
    const fetch = replayFetch([{ url, response: { body: body.subarray(1) } }]);
    await expect(downloadVerified(url, dest, { sha256, size: body.byteLength }, testContext({ fetch }))).rejects.toMatchObject({
      code: 'upstream',
    });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});
