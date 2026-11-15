import { describe, expect, it } from 'vitest';
import { Vid2ContextError } from '../src/errors.ts';
import { guessPlatform, KEY_OFFERS, type Recovery, shellQuote, suggestRecoveries } from '../src/recovery.ts';
import type { Attempt } from '../src/types.ts';

const URL = 'https://www.youtube.com/watch?v=Il2bjGSXvSw';

// The failure from a cloud server that YouTube refused (the web app showed it as a dead end before recoveries existed).
const blockedMessage =
  'YouTube player Il2bjGSXvSw: every client failed (android: LOGIN_REQUIRED: Sign in to confirm you’re not a bot; ios: LOGIN_REQUIRED: Sign in to confirm you’re not a bot)';
const blocked = new Vid2ContextError('blocked', blockedMessage, { status: 503 });
const blockedAttempts: Attempt[] = [
  { id: 'youtube', stage: 'resolve', outcome: 'ok', detail: 'youtube:Il2bjGSXvSw' },
  { id: 'youtube', stage: 'metadata', outcome: 'error', reason: 'blocked', detail: blockedMessage },
];

const actions = (rs: Recovery[]) => rs.map((r) => r.action);

describe('suggestRecoveries', () => {
  it('never leaves a blocked YouTube link in the web app without a way forward, download first', () => {
    const rs = suggestRecoveries(
      blocked,
      {
        surface: 'web',
        input: URL,
        downloads: true,
        keys: 'request',
        keyNames: ['SUPADATA_API_KEY'],
        imports: true,
        remote: true,
      },
      blockedAttempts,
    );
    expect(actions(rs)).toEqual([
      'download-media',
      'from-browser',
      'import-transcript',
      'local-file',
      'add-key',
      'retry',
      'run-locally',
    ]);
    expect(rs.find((r) => r.action === 'add-key')?.keys?.map((k) => k.name)).toEqual(['SUPADATA_API_KEY']);
  });

  it('leaves out what the surface cannot do', () => {
    const rs = suggestRecoveries(blocked, { surface: 'web', input: URL, keys: 'none' }, blockedAttempts);
    expect(actions(rs)).toEqual(['from-browser', 'local-file', 'retry']);
  });

  it('drops key offers the server does not accept per request', () => {
    const rs = suggestRecoveries(blocked, { surface: 'api', input: URL, keys: 'request', keyNames: ['GROQ_API_KEY'] });
    expect(actions(rs)).not.toContain('add-key');
  });

  it('gives the CLI commands it can run, with the link quoted for the shell', () => {
    const rs = suggestRecoveries(blocked, { surface: 'cli', input: URL, downloads: true, keys: 'env' }, blockedAttempts);
    expect(rs[0]).toMatchObject({ action: 'download-media', command: `vid2context download '${URL}' --audio mp3` });
    expect(rs.find((r) => r.action === 'local-file')?.command).toBe(`yt-dlp -x --audio-format mp3 -o audio.mp3 '${URL}'`);
    expect(rs.find((r) => r.action === 'add-key')?.detail).toContain('SUPADATA_API_KEY in .env');
    expect(actions(rs)).not.toContain('from-browser');
  });

  it('suggests installing yt-dlp where it is missing', () => {
    const rs = suggestRecoveries(blocked, { surface: 'mcp', input: URL, keys: 'env' }, blockedAttempts);
    expect(rs.find((r) => r.action === 'install')).toMatchObject({ command: 'pipx install yt-dlp' });
  });

  it('switches a captions-only run to transcription when the video has no captions', () => {
    const err = new Vid2ContextError('no-transcript', 'Could not get a transcript for youtube:abc (mode: captions).');
    const rs = suggestRecoveries(err, { surface: 'web', input: URL, mode: 'captions', imports: true });
    expect(rs[0]).toMatchObject({ action: 'switch-mode', mode: 'auto' });
  });

  it('offers a speech-to-text key when the audio was fetched but no rung could transcribe it', () => {
    const err = new Vid2ContextError('no-transcript', 'Could not get a transcript for youtube:abc (mode: auto).');
    const attempts: Attempt[] = [
      { id: 'youtube-audio', stage: 'audio', outcome: 'ok' },
      { id: 'stt/groq/whisper-large-v3-turbo', stage: 'stt', outcome: 'skipped', reason: 'no-key' },
    ];
    const rs = suggestRecoveries(err, { surface: 'web', input: URL, keys: 'browser', downloads: true }, attempts);
    expect(rs[0]).toMatchObject({ action: 'add-key', keys: KEY_OFFERS.stt });
    expect(actions(rs)).not.toContain('download-media');
  });

  it('names LLM keys when the llm stage has no rung', () => {
    const err = new Vid2ContextError('no-provider', 'No llm rung is enabled.', { stage: 'llm' });
    const rs = suggestRecoveries(err, { surface: 'web', keys: 'request' });
    expect(rs[0]?.keys?.map((k) => k.name)).toEqual(['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']);
  });

  it('waits out a rate limit before anything else', () => {
    const err = new Vid2ContextError('rate-limited', 'Too many requests.', { retryAfterSec: 12.2 });
    expect(suggestRecoveries(err, { surface: 'api' })[0]).toMatchObject({ action: 'retry', retryAfterSec: 13 });
  });

  it('only suggests fixing the link for a video that does not exist', () => {
    const err = new Vid2ContextError('not-found', 'YouTube xxxxxxxxxxx: ERROR (This video is unavailable)');
    const rc = { surface: 'web', input: URL, downloads: true, keys: 'request', imports: true, remote: true } as const;
    expect(actions(suggestRecoveries(err, rc))).toEqual(['fix-input']);
  });

  it('does not treat free text as a video link', () => {
    const err = new Vid2ContextError('unsupported-input', 'No source understands "not a video".');
    const rs = suggestRecoveries(err, { surface: 'cli', input: 'not a video', downloads: true, keys: 'env' });
    expect(actions(rs)).toEqual(['fix-input']);
  });

  it('treats unknown errors as transient and an abort as no failure at all', () => {
    expect(actions(suggestRecoveries(new Error('socket hang up'), { surface: 'web', input: URL }))).toContain('retry');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(suggestRecoveries(abort, { surface: 'web', input: URL })).toEqual([]);
  });

  it('does not offer to download an uploaded file again, and asks for a smaller one only when it was too large', () => {
    const err = new Vid2ContextError('no-transcript', 'Could not transcribe talk.mp3.');
    const rc = { surface: 'api', input: 'upload:ab12', downloads: true, keys: 'request' } as const;
    expect(actions(suggestRecoveries(err, rc))).toEqual(['add-key']);
    const tooLarge: Attempt[] = [
      { id: 'stt/groq/whisper-large-v3-turbo', stage: 'stt', outcome: 'skipped', reason: 'too-large' },
    ];
    const rs = suggestRecoveries(err, rc, tooLarge);
    expect(actions(rs)).toEqual(['add-key', 'local-file']);
    expect(rs[1]).toMatchObject({ title: 'Send a smaller audio file' });
    expect(rs[1]?.command).toBeUndefined();
  });

  it('does not tell a remote MCP client to pass a path on its own machine', () => {
    const rs = suggestRecoveries(blocked, { surface: 'mcp', input: URL, keys: 'env', remote: true }, blockedAttempts);
    expect(actions(rs)).not.toContain('local-file');
    expect(actions(rs)).toContain('run-locally');
  });
});

describe('helpers', () => {
  it('guesses the platform from the input', () => {
    expect(guessPlatform(URL)).toBe('youtube');
    expect(guessPlatform('https://youtu.be/Il2bjGSXvSw')).toBe('youtube');
    expect(guessPlatform('Il2bjGSXvSw')).toBe('youtube');
    expect(guessPlatform('upload:ab12')).toBe('upload');
    expect(guessPlatform('./talk.mp4')).toBe('file');
    expect(guessPlatform('https://vimeo.com/76979871')).toBe('web');
    expect(guessPlatform('')).toBeUndefined();
  });

  it('quotes shell arguments only when needed', () => {
    expect(shellQuote('https://youtu.be/abc')).toBe('https://youtu.be/abc');
    expect(shellQuote("it's here & there")).toBe(`'it'\\''s here & there'`);
  });
});
