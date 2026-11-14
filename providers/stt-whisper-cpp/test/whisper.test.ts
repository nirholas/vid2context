import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { inferenceUrl, inferViaServer } from '../src/server.ts';
import {
  buildCliArgs,
  cliError,
  parseCliJson,
  readConfig,
  realtimeDetail,
  timeoutFor,
  transcribeWhisperCpp,
  wavDurationSec,
  whisperLanguage,
} from '../src/whisper.ts';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(fixture(name), 'utf8'));
const text = (name: string) => readFileSync(fixture(name), 'utf8');

describe('parseCliJson (recorded whisper-cli 1.9.5 -oj output)', () => {
  it('turns base.en output into timed segments', () => {
    const r = parseCliJson(json('cli-base.en-apollo.json'), 'en');
    expect(r.language).toBe('en');
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toEqual({ startSec: 0, endSec: 16.12, text: "I'm going to step off the land now." });
    expect(r.segments[1]?.startSec).toBe(16.12);
    expect(r.segments[1]?.endSec).toBe(23.28);
    expect(r.segments[1]?.text).toContain('small step');
  });

  it('reads the detected language from tiny with -l auto', () => {
    const r = parseCliJson(json('cli-tiny-auto-apollo.json'));
    expect(r.language).toBe('en');
    expect(r.segments[0]?.endSec).toBe(7);
  });
});

describe('buildCliArgs', () => {
  const base = { model: '/m/ggml-small.bin', wav: '/t/a.wav', outBase: '/t/out', threads: 8 };

  it('auto-detects language by default and asks for JSON', () => {
    expect(buildCliArgs(base)).toEqual([
      '-m',
      '/m/ggml-small.bin',
      '-f',
      '/t/a.wav',
      '-oj',
      '-of',
      '/t/out',
      '-t',
      '8',
      '-np',
      '-l',
      'auto',
    ]);
  });

  it('passes language, prompt and translate as separate arguments', () => {
    const args = buildCliArgs({ ...base, language: 'de', prompt: 'Apollo; Armstrong "quoted"', translate: true });
    expect(args.slice(-5)).toEqual(['de', '--prompt', 'Apollo; Armstrong "quoted"', '-tr']);
  });

  it('forces English and drops translate for English-only models', () => {
    const args = buildCliArgs({ ...base, englishOnly: true, translate: true });
    expect(args.slice(-2)).toEqual(['-l', 'en']);
    expect(args).not.toContain('-tr');
  });
});

describe('helpers', () => {
  it('maps BCP-47 to whisper language codes', () => {
    expect(whisperLanguage('en-US')).toBe('en');
    expect(whisperLanguage('pt_BR')).toBe('pt');
    expect(whisperLanguage('auto')).toBeUndefined();
    expect(whisperLanguage(undefined)).toBeUndefined();
  });

  it('reads the duration from a real ffmpeg WAV header (24.11 s Apollo clip)', () => {
    const head = new Uint8Array(readFileSync(fixture('apollo-16k-mono.wav.head')));
    expect(wavDurationSec(head)).toBeCloseTo(24.112688, 4);
    expect(wavDurationSec(new TextEncoder().encode('not a wav file'))).toBeUndefined();
  });

  it('scales the timeout with audio length', () => {
    expect(timeoutFor(0)).toBe(60_000);
    expect(timeoutFor(3600)).toBe(60_000 + 36_000_000);
  });

  it('formats the realtime factor', () => {
    expect(realtimeDetail(24.1, 0.97, 'base.en', 'cli', 8)).toBe(
      '24.8x realtime (24.1 s audio in 0.97 s), model base.en, cli, 8 threads',
    );
  });

  it('reads config from env only', () => {
    expect(() => readConfig({})).toThrow(/WHISPER_CPP_MODEL/);
    const c = readConfig({
      WHISPER_CPP_MODEL: 'base.en',
      WHISPER_CPP_THREADS: '3',
      WHISPER_CPP_GPU: '1',
      WHISPER_CPP_SERVER: 'true',
    });
    expect(c).toEqual({ model: 'base.en', threads: 3, gpu: true, serverUrl: undefined, managedServer: true });
  });
});

describe('cliError (recorded stderr)', () => {
  it('maps a missing model to unavailable with a setup hint', () => {
    const e = cliError(text('stderr-model-not-found.txt'), 3, null, '/m/missing-model.bin');
    expect(e.code).toBe('unavailable');
    expect(e.hint).toMatch(/setup\.ts --model/);
  });

  it('maps unreadable audio to upstream with an ffmpeg hint', () => {
    const e = cliError(text('stderr-bad-audio.txt'), 11, null, '/m/ggml-tiny.bin');
    expect(e.code).toBe('upstream');
    expect(e.message).toContain('could not read the audio');
    expect(e.hint).toMatch(/ffmpeg/);
  });

  it('treats a SIGKILL as out of memory', () => {
    expect(cliError('', null, 'SIGKILL', '/m/x.bin').hint).toMatch(/smaller or quantized/);
  });
});

describe('server mode (recorded whisper-server 1.9.5 /inference response)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-cpp-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('builds the inference URL', () => {
    expect(inferenceUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/inference');
    expect(inferenceUrl('http://host/x/inference')).toBe('http://host/x/inference');
  });

  it('posts the WAV with verbose_json and parses segments and the language name', async () => {
    const wav = fixture('apollo-16k-mono.wav.head').pathname;
    const fetch = replayFetch([
      {
        method: 'POST',
        url: 'http://127.0.0.1:25913/inference',
        response: { headers: { 'content-type': 'application/json' }, body: text('server-base.en-apollo.verbose.json') },
      },
    ]);
    const ctx = testContext({ fetch });
    const r = await inferViaServer('http://127.0.0.1:25913', wav, { language: 'en', prompt: 'Apollo' }, ctx, 10_000);
    expect(r.language).toBe('en');
    expect(r.segments.map((s) => s.text).join(' ')).toContain('small step');
    expect(r.segments[0]).toMatchObject({ startSec: 0, endSec: 7 });
    const form = fetch.calls[0]?.body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('Apollo');
    expect(form.get('translate')).toBeNull();
  });

  it('maps the recorded 400 to an upstream error', async () => {
    const wav = fixture('apollo-16k-mono.wav.head').pathname;
    const fetch = replayFetch([
      { url: /\/inference$/, response: { status: 400, headers: { 'content-type': 'text/plain' }, body: 'Invalid request' } },
    ]);
    await expect(inferViaServer('http://127.0.0.1:25913', wav, {}, testContext({ fetch }), 10_000)).rejects.toMatchObject({
      code: 'upstream',
    });
  });
});

describe('transcribeWhisperCpp checks before spawning', () => {
  const audio = {
    kind: 'bytes' as const,
    data: new Uint8Array(readFileSync(fixture('apollo-16k-mono.wav.head'))),
    mimeType: 'audio/wav',
    filename: 'a.wav',
  };

  it('fails with a setup hint when the model file is missing', async () => {
    const ctx = testContext({
      env: { WHISPER_CPP_MODEL: 'base.en', VID2CONTEXT_HOME: join(tmpdir(), 'vid2context-whisper-empty-home') },
    });
    await expect(transcribeWhisperCpp(audio, {}, ctx)).rejects.toMatchObject({
      code: 'unavailable',
      hint: expect.stringMatching(/--model base\.en/),
    });
  });

  it('refuses another language on an English-only model', async () => {
    const ctx = testContext({ env: { WHISPER_CPP_MODEL: 'base.en' } });
    await expect(transcribeWhisperCpp(audio, { language: 'fr' }, ctx)).rejects.toMatchObject({
      code: 'unavailable',
      hint: expect.stringMatching(/multilingual/),
    });
  });
});
