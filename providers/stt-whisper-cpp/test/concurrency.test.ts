import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testContext } from '@vid2context/core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../src/exec.ts';
import { whisperConcurrency, withWhisperSlot } from '../src/whisper.ts';

// Real child processes (node itself) stand in for whisper-cli: the slots do not care what runs.
const NODE = process.execPath;
const dir = mkdtempSync(join(tmpdir(), 'v2c-whisper-slots-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const touch = (file: string) => ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'x')`];

describe('whisperConcurrency', () => {
  it('reads WHISPER_CONCURRENCY and defaults to 1', () => {
    expect(whisperConcurrency({})).toBe(1);
    expect(whisperConcurrency({ WHISPER_CONCURRENCY: '3' })).toBe(3);
    expect(whisperConcurrency({ WHISPER_CONCURRENCY: '0' })).toBe(1);
    expect(whisperConcurrency({ WHISPER_CONCURRENCY: 'two' })).toBe(1);
  });
});

describe('withWhisperSlot', () => {
  it('runs one whisper process at a time by default', async () => {
    const ctx = testContext();
    // Each child prints its own start and end time, so the overlap is measured where the work happens.
    const script = 'const s = Date.now(); setTimeout(() => console.log(s, Date.now()), 120)';
    const results = await Promise.all(
      Array.from({ length: 3 }, () => withWhisperSlot(ctx, () => run(NODE, ['-e', script], { timeoutMs: 10_000 }))),
    );
    const spans = results.map((r) => r.stdout.trim().split(' ').map(Number) as [number, number]);
    const peak = Math.max(...spans.map(([start]) => spans.filter(([s, e]) => s <= start && start < e).length));
    expect(peak).toBe(1);
  });

  it('a caller aborted while queued rejects at once and never spawns', async () => {
    const marker = join(dir, 'queued-ran');
    const holder = withWhisperSlot(testContext(), () => run(NODE, ['-e', 'setTimeout(() => {}, 600)'], { timeoutMs: 10_000 }));
    const controller = new AbortController();
    const queued = withWhisperSlot(testContext({ signal: controller.signal }), () =>
      run(NODE, touch(marker), { timeoutMs: 10_000, signal: controller.signal }),
    );
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('caller gave up')), 50);
    await expect(queued).rejects.toThrow('caller gave up');
    expect(Date.now() - started).toBeLessThan(400);
    await holder;
    // The aborted waiter left the queue, so the next caller gets the slot.
    const after = join(dir, 'after-ran');
    await withWhisperSlot(testContext(), () => run(NODE, touch(after), { timeoutMs: 10_000 }));
    expect(existsSync(after)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
