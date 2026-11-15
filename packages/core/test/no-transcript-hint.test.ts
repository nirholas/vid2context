/**
 * The no-transcript hint follows what was actually tried, so it never tells
 * someone to install yt-dlp when yt-dlp ran and was blocked.
 */
import { describe, expect, it } from 'vitest';
import { type Attempt, noTranscriptHint } from '../src/index.ts';

const captionsEmpty: Attempt = { id: 'youtube-captions', stage: 'captions', outcome: 'empty', reason: 'no-tracks' };

describe('noTranscriptHint', () => {
  it('suggests yt-dlp only when no source could download the audio', () => {
    const hint = noTranscriptHint([
      captionsEmpty,
      { id: 'audio', stage: 'audio', outcome: 'skipped', reason: 'no-audio-provider' },
    ]);
    expect(hint).toContain('Install the yt-dlp provider');
  });

  it('says the audio download failed, with the reason, when yt-dlp ran', () => {
    const hint = noTranscriptHint([captionsEmpty, { id: 'ytdlp', stage: 'audio', outcome: 'error', reason: 'blocked' }]);
    expect(hint).toContain('The audio could not be downloaded (blocked)');
    expect(hint).not.toContain('Install');
  });

  it('points at speech-to-text when the audio arrived', () => {
    const audioOk: Attempt = { id: 'ytdlp', stage: 'audio', outcome: 'ok' };
    expect(noTranscriptHint([captionsEmpty, audioOk])).toContain('no speech-to-text rung is enabled');
    expect(
      noTranscriptHint([
        captionsEmpty,
        audioOk,
        { id: 'stt/groq/whisper-large-v3', stage: 'stt', outcome: 'error', reason: 'auth' },
      ]),
    ).toContain('every speech-to-text rung failed');
  });

  it('falls back to the attempts when nothing above applies', () => {
    expect(noTranscriptHint([captionsEmpty])).toBe('Check `attempts` for why each step failed.');
  });
});
