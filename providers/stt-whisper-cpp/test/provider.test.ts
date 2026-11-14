import { describe, expect, it } from 'vitest';
import { detectHardware } from '../src/hardware.ts';
import provider, { CPU_PRIORITY, GPU_PRIORITY, whisperCppRungs } from '../src/index.ts';

describe('provider', () => {
  it('is a node-only stt provider', () => {
    expect(provider).toMatchObject({ id: 'stt-whisper-cpp', kind: 'stt', runtimes: ['node'] });
  });

  it('is disabled without WHISPER_CPP_MODEL and decides from env alone', () => {
    const [off] = whisperCppRungs({});
    expect(off?.id).toBe('stt/whisper-cpp');
    expect(off?.isEnabled?.({})).toBe(false);
    expect(off?.requires).toEqual(['WHISPER_CPP_MODEL']);
    // A path that does not exist still enables the rung: files are checked at transcription time.
    const env = { WHISPER_CPP_MODEL: '/nowhere/ggml-large-v3-turbo-q5_0.bin' };
    const [on] = whisperCppRungs(env);
    expect(on?.isEnabled?.(env)).toBe(true);
    expect(on?.id).toBe('stt/whisper-cpp/large-v3-turbo-q5_0');
  });

  it('is a local rung with no upload limit, ordered by WHISPER_CPP_GPU', () => {
    const [cpu] = whisperCppRungs({ WHISPER_CPP_MODEL: 'small' });
    expect(cpu).toMatchObject({ tier: 'local', priority: CPU_PRIORITY, quality: 3 });
    expect(cpu?.maxBytes).toBeUndefined();
    expect(cpu?.capabilities).toEqual(['segments', 'language-detect', 'prompt', 'translate']);
    const [gpu] = whisperCppRungs({ WHISPER_CPP_MODEL: 'large-v3-turbo', WHISPER_CPP_GPU: '1' });
    expect(gpu?.priority).toBe(GPU_PRIORITY);
    expect(GPU_PRIORITY).toBeLessThan(10);
    expect(CPU_PRIORITY).toBeGreaterThan(10);
  });

  it('drops language-detect and translate for English-only models', () => {
    const [en] = whisperCppRungs({ WHISPER_CPP_MODEL: 'base.en' });
    expect(en?.capabilities).toEqual(['segments', 'prompt']);
  });
});

describe('detectHardware on this machine (local probes only, no network)', () => {
  it('reports CPU and memory and a known GPU vendor', async () => {
    const hw = await detectHardware();
    expect(hw.cpuCores).toBeGreaterThan(0);
    expect(hw.memoryMb).toBeGreaterThan(0);
    expect(['nvidia', 'apple', 'amd', 'intel', 'none']).toContain(hw.gpu.vendor);
  });
});
