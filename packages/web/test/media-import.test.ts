/**
 * Transcripts made from the video itself (lib/media-import.ts), on responses
 * recorded from the real API (test/fixtures/README.md): the Apollo 11 clip
 * transcribed by the server's speech-to-text chain as an upload, and a real
 * server-side download job from start to finish, plus one that failed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vid2ContextError, type VideoContext } from '@vid2context/core';
import { replayFetch } from '@vid2context/core/testing';
import { validateImportRequest } from '@vid2context/imports';
import { describe, expect, it } from 'vitest';
import type { DownloadJob } from '../src/lib/downloads.ts';
import { originBadges } from '../src/lib/format.ts';
import { canImportAfter, isImportableInput } from '../src/lib/imports.ts';
import {
  downloadAudioOnServer,
  fetchJobFile,
  jobError,
  mediaImportBody,
  toMediaTranscript,
  transcriberOf,
  ytdlpCommand,
} from '../src/lib/media-import.ts';
import { BASE, ROOT, recorded } from './helpers.ts';

const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const upload = recorded('context-upload-apollo.json').body as VideoContext;
const body = <T>(name: string) => recorded(name).body as T;
const json = (v: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });

describe('a transcript made from the media', () => {
  it('keeps the segments, the detected language and the rung that made them', () => {
    if (!upload.transcript) throw new Error('fixture has no transcript');
    expect(transcriberOf(upload.attempts)).toBe('stt/cloudflare/@cf/openai/whisper-large-v3-turbo');
    const t = toMediaTranscript(upload.transcript, upload.attempts, 24.1);
    expect(t.language).toBe('en');
    expect(t.segments).toEqual(
      upload.transcript.segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text.trim() })),
    );

    // POST /imports accepts the body as is, for the video's link, with via=media.
    const req = mediaImportBody(ZOO, t);
    expect(validateImportRequest(req)).toEqual({
      url: ZOO,
      segments: t.segments,
      language: 'en',
      via: 'media',
      transcriber: 'stt/cloudflare/@cf/openai/whisper-large-v3-turbo',
    });
    // The language the run asked for wins over the detected one.
    expect(mediaImportBody(ZOO, t, 'de').language).toBe('de');
  });

  it('leaves an undetermined language out and refuses audio with no speech', () => {
    if (!upload.transcript) throw new Error('fixture has no transcript');
    const und = toMediaTranscript({ ...upload.transcript, language: 'und' }, upload.attempts, 24.1);
    expect(und.language).toBeUndefined();
    expect(mediaImportBody(ZOO, und)).not.toHaveProperty('language');

    const silent = { ...upload.transcript, segments: upload.transcript.segments.map((s) => ({ ...s, text: '  ' })) };
    expect(() => toMediaTranscript(silent, upload.attempts, 24.1)).toThrow(
      expect.objectContaining({ code: 'no-transcript', hint: expect.stringContaining('spoken soundtrack') }),
    );
  });

  it('labels the result as speech-to-text from the audio', () => {
    if (!upload.transcript) throw new Error('fixture has no transcript');
    const [badge] = originBadges({ ...upload.transcript, origin: 'imported', producer: 'import/media' });
    expect(badge).toMatchObject({ label: 'Imported transcript', tone: 'ok' });
    expect(badge?.title).toContain("speech-to-text from the video's audio");
  });
});

describe('a server-side download', () => {
  it('starts an m4a audio job and polls it until the file is ready', async () => {
    const start = body<DownloadJob>('downloads-start.json');
    const snapshots = [body<DownloadJob>('downloads-job-running.json'), body<DownloadJob>('downloads-job-done.json')];
    const fetch = replayFetch([
      { method: 'POST', url: `${BASE}/downloads`, response: json(start) },
      { method: 'GET', url: `${BASE}/downloads/${start.id}`, response: () => json(snapshots.shift()) },
    ]);
    const seen: string[] = [];
    const job = await downloadAudioOnServer(
      ZOO,
      { onJob: (j) => seen.push(j.status), pollMs: 1, call: { base: BASE, fetch } },
      new AbortController().signal,
    );
    expect(seen).toEqual(['running', 'running', 'done']);
    expect(job.file).toMatchObject({ bytes: 387692 });
    expect(JSON.parse(String(fetch.calls[0]?.body))).toEqual({ url: ZOO, kind: 'audio', format: 'm4a', quality: 'best' });
  });

  it('throws the job error with its hint when the server could not download', async () => {
    const start = body<DownloadJob>('downloads-start-mp4.json');
    const failed = body<DownloadJob>('downloads-job-mp4-error.json');
    const fetch = replayFetch([
      { method: 'POST', url: `${BASE}/downloads`, response: json(start) },
      { method: 'GET', url: `${BASE}/downloads/${start.id}`, response: json(failed) },
    ]);
    const err = await downloadAudioOnServer(
      ZOO,
      { onJob: () => {}, pollMs: 1, call: { base: BASE, fetch } },
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err).toMatchObject({ code: failed.error?.code, message: failed.error?.message, hint: failed.error?.hint });
    expect(jobError({ ...failed, status: 'canceled' }).message).toBe('The download was canceled on the server.');
  });

  it("fetches the finished file into the browser with the job's name and type", async () => {
    const done = body<DownloadJob>('downloads-job-done.json');
    const mp3 = readFileSync(join(ROOT, 'tests', 'fixtures', 'media', 'apollo11-small-step.mp3'));
    const fetch = replayFetch([
      {
        method: 'GET',
        url: `${BASE}/downloads/${done.id}/file`,
        response: { headers: { 'content-type': 'audio/mpeg' }, body: new Uint8Array(mp3) },
      },
    ]);
    const steps: (number | undefined)[] = [];
    const file = await fetchJobFile(
      done,
      { onStep: (s) => steps.push(s.percent), call: { base: BASE, fetch } },
      new AbortController().signal,
    );
    expect(file.name).toBe(done.file?.filename);
    expect(file.type).toBe(done.file?.mimeType);
    expect(file.size).toBe(mp3.byteLength);
    expect(steps.length).toBeGreaterThan(0);
  });
});

describe('when the import panel is offered', () => {
  const blocked = new Vid2ContextError('blocked', 'YouTube answered HTTP 429 (automated-traffic block).');
  it('offers it after blocks and failed speech-to-text, for YouTube and other single links', () => {
    expect(canImportAfter(ZOO, blocked)).toBe(true);
    expect(canImportAfter(ZOO, new Vid2ContextError('no-provider', 'No speech-to-text rung is configured.'))).toBe(true);
    expect(canImportAfter('https://vimeo.com/1133654544', blocked)).toBe(true);
    expect(canImportAfter(ZOO, new Vid2ContextError('bad-request', 'Missing url.'))).toBe(false);
    expect(canImportAfter(ZOO, new Error('plain'))).toBe(false);
    expect(isImportableInput('not a link')).toBe(false);
  });

  it('builds a yt-dlp command that cannot run anything when pasted', () => {
    expect(ytdlpCommand('https://youtu.be/jNQXAC9IVRw?si=abc')).toBe(
      'yt-dlp -f "bestaudio[ext=m4a]/bestaudio" -o "%(title)s [%(id)s].%(ext)s" "https://www.youtube.com/watch?v=jNQXAC9IVRw"',
    );
    const cmd = ytdlpCommand('https://example.com/v/$(touch pwned)`id`"x\\!');
    expect(cmd).toContain('"https://example.com/v/%24(touch%20pwned)%60id%60%22x%5C%21"');
    expect(cmd.slice(cmd.lastIndexOf(' "'))).not.toMatch(/[$`!\\]|"[^"]*"[^"]*"/);
  });
});
