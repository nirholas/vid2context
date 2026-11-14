import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createContext, type Env } from '@vid2context/core';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../src/paths.ts';
import { setupWhisperCpp } from '../src/setup.ts';
import { transcribeWhisperCpp } from '../src/whisper.ts';

const clip = new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url);

function whisperPids(marker: string): number[] {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.includes('whisper-cli') && l.includes(marker))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

describe.skipIf(!process.env.LIVE)('whisper.cpp live', () => {
  const home = mkdtempSync(join(tmpdir(), 'vid2context-whisper-live-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const env: Env = { ...(process.env as Env), VID2CONTEXT_HOME: home, VID2CONTEXT_LOG_LEVEL: 'warn' };
  let lineEnv: Record<string, string> = {};

  it('installs, downloads tiny.en verified, and smoke-transcribes the Apollo clip', { timeout: 30 * 60_000 }, async () => {
    const r = await setupWhisperCpp({ model: 'tiny.en' }, createContext({ runtime: 'node', env }));
    expect(r.model.name).toBe('tiny.en');
    expect(r.model.sha256).toBe('921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f');
    expect(r.smoke?.text).toContain('small step');
    expect(r.smoke?.realtimeFactor).toBeGreaterThan(0);
    expect(r.env.WHISPER_CPP_MODEL).toBe('tiny.en');
    lineEnv = r.env;
  });

  it('transcribes through the env lines setup printed', { timeout: 5 * 60_000 }, async () => {
    const ctx = createContext({ runtime: 'node', env: { ...env, ...lineEnv } });
    const data = new Uint8Array(readFileSync(clip));
    const r = await transcribeWhisperCpp(
      { kind: 'bytes', data, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' },
      { language: 'en' },
      ctx,
    );
    expect(r.segments.map((s) => s.text).join(' ')).toContain('small step');
    expect(r.segments.at(-1)?.endSec).toBeGreaterThan(20);
    expect(r.detail).toMatch(/x realtime/);
  });

  it('kills whisper-cli when the signal aborts', { timeout: 5 * 60_000 }, async () => {
    const ffmpeg = resolveFfmpeg(env);
    if (!ffmpeg) throw new Error('ffmpeg is required for this test');
    // About 8 minutes of audio: the clip looped, so whisper-cli is still running when we abort.
    const long = join(home, 'long.wav');
    execFileSync(ffmpeg, [
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-stream_loop',
      '20',
      '-i',
      clip.pathname,
      '-ar',
      '16000',
      '-ac',
      '1',
      long,
    ]);
    const ac = new AbortController();
    const ctx = createContext({ runtime: 'node', env: { ...env, ...lineEnv }, signal: ac.signal });
    const data = new Uint8Array(readFileSync(long));
    const p = transcribeWhisperCpp({ kind: 'bytes', data, mimeType: 'audio/wav', filename: 'long.wav' }, {}, ctx);
    const deadline = Date.now() + 30_000;
    while (whisperPids(home).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(whisperPids(home).length).toBe(1);
    ac.abort();
    await expect(p).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    expect(whisperPids(home)).toEqual([]);
  });
});
