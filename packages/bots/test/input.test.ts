import { describe, expect, it } from 'vitest';
import { commandArg, extractSlackUrls, extractUrls, looksLocal, pickVideo, resolveVideo } from '../src/input.ts';
import { RateLimiter, SeenIds } from '../src/ratelimit.ts';
import { telegramUrls } from '../src/telegram.ts';
import { fixtureJson, testRegistry, VIDEO_URL } from './helpers.ts';

const registry = testRegistry();

describe('link extraction', () => {
  it('finds URLs in free text and strips trailing punctuation', () => {
    expect(extractUrls(`Watch this: ${VIDEO_URL}. And (https://youtu.be/jNQXAC9IVRw)!`)).toEqual([
      VIDEO_URL,
      'https://youtu.be/jNQXAC9IVRw',
    ]);
    expect(extractUrls('https://en.wikipedia.org/wiki/Apollo_(program) is long')).toEqual([
      'https://en.wikipedia.org/wiki/Apollo_(program)',
    ]);
  });

  it('reads Slack link markup and skips mentions', () => {
    const mention = fixtureJson<{ event: { text: string } }>('slack-app-mention.json').event.text;
    expect(extractSlackUrls(mention)).toEqual([]);
    expect(extractSlackUrls(`${mention} <${VIDEO_URL}|the video>`)).toEqual([VIDEO_URL]);
    expect(commandArg(`<${VIDEO_URL.replace('&', '&amp;')}>`)).toBe(VIDEO_URL);
    expect(commandArg(`  ${VIDEO_URL} `)).toBe(VIDEO_URL);
  });

  it('uses Telegram url and text_link entities', () => {
    const text = 'see youtu.be/jNQXAC9IVRw and this';
    expect(
      telegramUrls(text, [
        { type: 'url', offset: 4, length: 20 },
        { type: 'text_link', offset: 29, length: 4, url: VIDEO_URL },
      ]),
    ).toEqual(['https://youtu.be/jNQXAC9IVRw', VIDEO_URL]);
  });
});

describe('video inputs only', () => {
  it('resolves a YouTube link to a video ref', () => {
    expect(resolveVideo(registry, VIDEO_URL).id).toBe('youtube:cCPsdFdlshc');
  });

  it.each(['/etc/passwd', '~/talk.mp3', './talk.mp3', '..\\talk.mp3', 'file:///etc/passwd', 'C:\\talk.mp3'])(
    'refuses the local path %s before the registry sees it',
    (input) => {
      expect(looksLocal(input)).toBe(true);
      expect(() => resolveVideo(registry, input)).toThrow('Only links to online videos are accepted.');
    },
  );

  it('refuses inputs that a source resolves to the file platform', () => {
    // A bare media file name is not path-like, but media-file still claims it.
    expect(looksLocal('talk.mp3')).toBe(false);
    expect(registry.resolve('talk.mp3').ref.platform).toBe('file');
    expect(() => resolveVideo(registry, 'talk.mp3')).toThrow('Only links to online videos are accepted.');
  });

  it('refuses playlists and unknown sites with a bot-friendly hint', () => {
    expect(() => resolveVideo(registry, 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b')).toThrow(
      'not a single video',
    );
    try {
      resolveVideo(registry, 'https://example.com/article');
    } catch (err) {
      expect((err as { hint?: string }).hint).not.toContain('local');
    }
  });

  it('picks the first candidate that is a video', () => {
    expect(pickVideo(registry, ['https://example.com/a', VIDEO_URL]).ref.nativeId).toBe('cCPsdFdlshc');
  });
});

describe('rate limits', () => {
  it('counts per key in a sliding hour and blocks when any key is full', () => {
    const rl = new RateLimiter();
    const t0 = 1_000_000;
    expect(rl.take(['chat:1', 'user:1'], 2, t0).ok).toBe(true);
    expect(rl.take(['chat:1', 'user:2'], 2, t0 + 1000).ok).toBe(true);
    const third = rl.take(['chat:1', 'user:3'], 2, t0 + 2000);
    expect(third).toEqual({ ok: false, retryAfterSec: 3598 });
    // A blocked request does not count against the other key.
    expect(rl.take(['chat:2', 'user:3'], 2, t0 + 3000).ok).toBe(true);
    expect(rl.take(['chat:1', 'user:4'], 2, t0 + 3_600_001).ok).toBe(true);
    expect(rl.take(['x'], 0, t0).ok).toBe(false);
  });

  it('remembers ids up to a bound', () => {
    const seen = new SeenIds(2);
    expect(seen.seen('a')).toBe(false);
    expect(seen.seen('a')).toBe(true);
    seen.seen('b');
    seen.seen('c');
    expect(seen.seen('a')).toBe(false);
  });
});
