import { describe, expect, it } from 'vitest';
import { checkFile, isAudioOnly, isMediaFile } from '../src/audio/decode.ts';
import { wavName } from '../src/audio/prepare.ts';
import { encodeWav, readWavHeader, WAV_HEADER_BYTES, wavBytesFor } from '../src/audio/wav.ts';
import { formatBytes, formatDuration, originBadges, spokenDuration, timeAgo } from '../src/lib/format.ts';
import { runKey, summarize } from '../src/lib/history.ts';
import { runPool } from '../src/lib/pool.ts';
import { parseRoute, runSearch } from '../src/lib/route.ts';
import { cleanKeys, KEY_NAME } from '../src/lib/settings.ts';
import { sharedContext } from './helpers.ts';

describe('routes', () => {
  it('round-trips run parameters through the query string', () => {
    const search = runSearch({ url: 'https://youtu.be/jNQXAC9IVRw', mode: 'stt', lang: 'de', comments: true, timestamps: true });
    expect(search).toBe('?url=https%3A%2F%2Fyoutu.be%2FjNQXAC9IVRw&mode=stt&lang=de&comments=1&timestamps=1');
    expect(parseRoute(search)).toEqual({
      view: 'run',
      url: 'https://youtu.be/jNQXAC9IVRw',
      mode: 'stt',
      lang: 'de',
      comments: true,
      timestamps: true,
    });
  });

  it('accepts the landing page hand-off and ignores unknown modes', () => {
    expect(parseRoute('?url=jNQXAC9IVRw&mode=bogus&lang=')).toMatchObject({
      view: 'run',
      url: 'jNQXAC9IVRw',
      mode: 'auto',
      lang: '',
    });
    expect(parseRoute('?view=settings')).toEqual({ view: 'settings' });
    expect(parseRoute('?url=%20%20')).toEqual({ view: 'home' });
    expect(runSearch({ url: 'x', mode: 'auto' })).toBe('?url=x');
  });
});

describe('format helpers', () => {
  it('formats sizes, durations and relative times', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4418)).toBe('4.3 KB');
    expect(formatBytes(1_920_044)).toBe('1.8 MB');
    expect(formatDuration(1093)).toBe('18:13');
    expect(spokenDuration(19)).toBe('19 seconds');
    expect(spokenDuration(3720)).toBe('1 hour 2 minutes');
    const now = Date.parse('2026-11-14T16:00:00Z');
    expect(timeAgo(now - 10_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(timeAgo(now - 26 * 3600_000, now)).toBe('yesterday');
  });

  it('names transcript origins in plain words', () => {
    expect(originBadges(sharedContext('youtube-jNQXAC9IVRw').transcript)[0]?.label).toBe('Creator captions');
    expect(originBadges(sharedContext('youtube-cCPsdFdlshc').transcript)[0]?.label).toBe('Auto-captions');
  });
});

describe('history entries', () => {
  it('keys results by input, mode and language, and summarizes them', () => {
    expect(runKey(' jNQXAC9IVRw ', 'auto', '')).toBe('auto||jNQXAC9IVRw');
    expect(runKey('jNQXAC9IVRw', 'stt', 'de')).not.toBe(runKey('jNQXAC9IVRw', 'auto', 'de'));
    const e = summarize(sharedContext('youtube-jNQXAC9IVRw'), { input: 'https://youtu.be/jNQXAC9IVRw' }, 12);
    expect(e).toMatchObject({
      videoId: 'youtube:jNQXAC9IVRw',
      title: 'Me at the zoo',
      channel: 'jawed',
      durationSec: 19,
      fileCount: 12,
    });
  });
});

describe('runPool', () => {
  it('never runs more than the limit at once and keeps order', async () => {
    let running = 0;
    let peak = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (n === 4) throw new Error('four');
      return n * 2;
    });
    expect(peak).toBe(3);
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([2, 4, 6, 'x', 10, 12, 14]);
  });
});

describe('WAV encoding', () => {
  it('writes 16-bit mono PCM at 32,000 bytes per second of 16 kHz audio', () => {
    const samples = new Float32Array(16_000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16_000);
    const wav = encodeWav(samples, 16_000);
    expect(wav.length).toBe(WAV_HEADER_BYTES + 32_000);
    expect(wavBytesFor(16_000 * 60)).toBe(44 + 1_920_000);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(readWavHeader(wav)).toEqual({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, samples: 16_000 });
  });

  it('clips samples outside -1..1', () => {
    const wav = encodeWav(new Float32Array([2, -2]), 16_000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });
});

describe('file checks', () => {
  it('accepts audio and video, and says why it rejects other files', () => {
    expect(isMediaFile({ name: 'a.mp3', type: '' })).toBe(true);
    expect(isMediaFile({ name: 'clip', type: 'video/mp4' })).toBe(true);
    expect(isAudioOnly({ name: 'a.m4a', type: '' })).toBe(true);
    expect(isAudioOnly({ name: 'a.webm', type: 'video/webm' })).toBe(false);
    expect(() => checkFile({ name: 'notes.pdf', type: 'application/pdf', size: 10 })).toThrow('is not an audio or video file');
    expect(() => checkFile({ name: 'a.mp3', type: 'audio/mpeg', size: 0 })).toThrow('is empty');
    expect(() => checkFile({ name: 'a.mp4', type: 'video/mp4', size: 3 * 1024 ** 3 })).toThrow('larger than 2 GB');
    expect(wavName('talk.final.mp4')).toBe('talk.final.wav');
  });
});

describe('provider keys', () => {
  it('keeps only named, non-empty values with env-style names', () => {
    expect(
      cleanKeys([
        { name: ' groq_api_key ', value: ' abc ' },
        { name: '', value: 'x' },
        { name: 'A', value: '' },
      ]),
    ).toEqual({
      GROQ_API_KEY: 'abc',
    });
    expect(KEY_NAME.test('TRANSFORMERS_STT_MODEL')).toBe(true);
    expect(KEY_NAME.test('1BAD')).toBe(false);
  });
});
