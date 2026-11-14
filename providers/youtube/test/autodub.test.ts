/**
 * Auto-dubbed videos list one auto-caption track per dubbed language, in
 * alphabetical order, so "the first asr track" is not the spoken language.
 * Real recording: r3UXC_U6iCQ (Alliance Motorworks, spoken in English, with
 * YouTube auto-dubs in 19 languages; ANDROID player, 2026-11-14).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { choose, originalLanguage, spokenLanguage, tracksOf } from '../src/captions/tracks.ts';
import { toMetadata } from '../src/metadata/index.ts';
import type { PlayerResponse } from '../src/resilience/player.ts';
import { matchYouTube } from '../src/url.ts';

const player = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as PlayerResponse;
const dubbed = player('player-autodubbed-r3UXC_U6iCQ.json');

describe('auto-dubbed videos', () => {
  it('has an auto-caption track per dubbed language, Bangla first', () => {
    const asr = tracksOf(dubbed).filter((t) => t.kind === 'asr');
    expect(asr).toHaveLength(20);
    expect(asr[0]?.languageCode).toBe('bn');
  });

  it('finds the original audio language, not the alphabetically first track', () => {
    expect(originalLanguage(dubbed)).toBe('en');
    expect(spokenLanguage(tracksOf(dubbed), originalLanguage(dubbed))).toBe('en');
    // The old rule, kept for callers that pass no hint.
    expect(spokenLanguage(tracksOf(dubbed))).toBe('bn');
  });

  it('chooses the English auto-captions by default and still honours a requested language', () => {
    expect(choose(dubbed, {})).toMatchObject({ origin: 'auto-captions', track: { languageCode: 'en' } });
    expect(choose(dubbed, { language: 'de' })?.track.languageCode).toBe('de-DE');
    expect(choose(dubbed, { allowAuto: false })).toBeNull();
  });

  it('reports English as the metadata language', () => {
    const ref = matchYouTube('https://www.youtube.com/watch?v=r3UXC_U6iCQ');
    if (!ref) throw new Error('no match');
    expect(toMetadata(ref, dubbed).language).toBe('en');
  });

  it('leaves single-track videos as they were', () => {
    const gwagon = player('player-cCPsdFdlshc.json');
    expect(originalLanguage(gwagon)).toBe('en');
    expect(originalLanguage(player('player-jNQXAC9IVRw.json'))).toBeUndefined();
  });
});
