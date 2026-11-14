import { describe, expect, it } from 'vitest';
import { audioArgs, commonArgs, configFrom, isYouTubeUrl, metadataArgs, subtitleArgs } from '../src/args.ts';

const node = { name: 'node', path: '/usr/bin/node' } as const;

describe('YOUTUBE_PROXY for yt-dlp', () => {
  it('takes the first http(s) entry of YOUTUBE_PROXY', () => {
    expect(configFrom({ YOUTUBE_PROXY: ' http://u:p@a:1 , http://b:2' }, node).youtubeProxy).toBe('http://u:p@a:1');
    expect(configFrom({ YOUTUBE_PROXY: 'socks5://a:1' }, node).youtubeProxy).toBeUndefined();
    expect(configFrom({}, node).youtubeProxy).toBeUndefined();
  });

  it('passes --proxy for YouTube URLs only', () => {
    const cfg = configFrom({ YOUTUBE_PROXY: 'http://a:1' }, node);
    for (const args of [
      metadataArgs('https://www.youtube.com/watch?v=jNQXAC9IVRw', cfg),
      audioArgs('https://youtu.be/jNQXAC9IVRw', cfg, '/tmp/x.%(ext)s'),
      subtitleArgs('https://m.youtube.com/watch?v=jNQXAC9IVRw', cfg, { language: 'en', auto: true, outTemplate: '/tmp/s' }),
    ]) {
      const i = args.indexOf('--proxy');
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe('http://a:1');
      expect(i).toBeLessThan(args.indexOf('--'));
    }
    expect(metadataArgs('https://vimeo.com/76979871', cfg)).not.toContain('--proxy');
    expect(commonArgs(cfg)).not.toContain('--proxy');
  });

  it('recognises YouTube hosts and not look-alikes', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(isYouTubeUrl('https://music.youtube.com/watch?v=x')).toBe(true);
    expect(isYouTubeUrl('https://www.youtube-nocookie.com/embed/x')).toBe(true);
    expect(isYouTubeUrl('https://youtube.com.evil.example/watch')).toBe(false);
    expect(isYouTubeUrl('https://notyoutube.com/watch')).toBe(false);
  });
});
