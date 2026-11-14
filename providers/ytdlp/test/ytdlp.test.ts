import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, Vid2ContextError } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { matchYouTube } from '@vid2context/provider-youtube';
import { describe, expect, it } from 'vitest';
import { audioArgs, commentsArgs, metadataArgs, playlistArgs, type RunConfig, safeUrl, subtitleArgs } from '../src/args.ts';
import { assetName, latestTag, parseSums, withLock } from '../src/binary.ts';
import { chooseSubtitle, listTracks } from '../src/captions.ts';
import { errorFromStderr } from '../src/errors.ts';
import { entryRef, toComments, toMetadata, type YtDlpInfo } from '../src/info.ts';
import { run } from '../src/process.ts';
import { canonicalUrl, matchUrl, vimeoPlayerUrl } from '../src/refs.ts';
import { parseJson, timeoutMs } from '../src/run.ts';
import { parseVtt } from '../src/vtt.ts';

// Fixtures are real recordings (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const info = (name: string) => JSON.parse(fixture(name)) as YtDlpInfo;

const ref = (url: string) => {
  const r = matchUrl(url);
  if (!r) throw new Error(`no match for ${url}`);
  return r;
};

const NODE: RunConfig = { jsRuntime: { name: 'node', path: '/usr/bin/node' }, ffmpeg: '/opt/ffmpeg' };
const DENO: RunConfig = { jsRuntime: { name: 'deno', path: '/usr/local/bin/deno' } };

describe('matchUrl', () => {
  it('gives YouTube URLs the same ref as the YouTube provider', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      'https://youtu.be/jNQXAC9IVRw',
      'https://www.youtube.com/shorts/jNQXAC9IVRw',
    ]) {
      expect(matchUrl(url)).toEqual(matchYouTube(url));
      expect(matchUrl(url)?.id).toBe('youtube:jNQXAC9IVRw');
    }
  });

  it('accepts any http(s) URL and nothing else', () => {
    expect(ref('https://vimeo.com/76979871').platform).toBe('vimeo');
    expect(ref('https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity').platform).toBe('ted');
    expect(ref('https://x.com/NASA/status/1').platform).toBe('twitter');
    expect(ref('https://news.example.org/story/video').platform).toBe('web');
    expect(matchUrl('jNQXAC9IVRw')).toBeNull();
    expect(matchUrl('file:///tmp/a.mp4')).toBeNull();
    expect(matchUrl('ftp://example.org/a.mp4')).toBeNull();
    expect(matchUrl('-o /tmp/x')).toBeNull();
  });

  it('hashes the canonical URL so tracking parameters and www. do not change the id', () => {
    const a = ref('https://www.vimeo.com/76979871?utm_source=x#t=3');
    const b = ref('https://vimeo.com/76979871/');
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^vimeo:[0-9a-f]{32}$/);
    expect(a.nativeId).toHaveLength(32);
    expect(canonicalUrl('https://WWW.Example.org/v?b=2&a=1&fbclid=z')?.href).toBe('https://example.org/v?a=1&b=2');
  });

  it('detects lists conservatively', () => {
    expect(ref('https://vimeo.com/showcase/1765357').kind).toBe('playlist');
    expect(ref('https://vimeo.com/showcase/1765357').id).toMatch(/^vimeo:playlist:/);
    expect(ref('https://www.tiktok.com/@nasa').kind).toBe('channel');
    expect(ref('https://www.tiktok.com/@nasa/video/7').kind).toBe('video');
  });

  it('maps vimeo.com pages to the player URL for the login fallback', () => {
    expect(vimeoPlayerUrl('https://vimeo.com/76979871')).toBe('https://player.vimeo.com/video/76979871');
    expect(vimeoPlayerUrl('https://vimeo.com/channels/staffpicks/76979871')).toBe('https://player.vimeo.com/video/76979871');
    expect(vimeoPlayerUrl('https://vimeo.com/123456/abcdef1234')).toBe('https://player.vimeo.com/video/123456?h=abcdef1234');
    expect(vimeoPlayerUrl('https://vimeo.com/showcase/1765357')).toBeNull();
    expect(vimeoPlayerUrl('https://player.vimeo.com/video/76979871')).toBeNull();
  });
});

describe('argument building', () => {
  const url = 'https://player.vimeo.com/video/76979871';

  it('builds the exact metadata argv with -- before the URL', () => {
    expect(metadataArgs(url, NODE)).toEqual([
      '--ignore-config',
      '--no-color',
      '--no-progress',
      '--js-runtimes',
      'node:/usr/bin/node',
      '--ffmpeg-location',
      '/opt/ffmpeg',
      '-J',
      '--no-download',
      '--no-playlist',
      '--no-warnings',
      '--',
      url,
    ]);
  });

  it('leaves the JS runtime to yt-dlp when deno is present and passes cookies', () => {
    const cfg: RunConfig = { ...DENO, cookiesFile: '/home/u/cookies.txt', cookiesFromBrowser: 'firefox' };
    expect(metadataArgs(url, cfg)).toEqual([
      '--ignore-config',
      '--no-color',
      '--no-progress',
      '--cookies',
      '/home/u/cookies.txt',
      '--cookies-from-browser',
      'firefox',
      '-J',
      '--no-download',
      '--no-playlist',
      '--no-warnings',
      '--',
      url,
    ]);
  });

  it('builds playlist, comments, subtitle and audio argv', () => {
    expect(playlistArgs(url, DENO, 5).slice(3)).toEqual([
      '--flat-playlist',
      '-J',
      '--no-warnings',
      '--playlist-end',
      '5',
      '--',
      url,
    ]);
    expect(commentsArgs(url, DENO, 20).slice(3)).toEqual([
      '-J',
      '--no-download',
      '--no-playlist',
      '--no-warnings',
      '--write-comments',
      '--extractor-args',
      'youtube:max_comments=20,20,20,10;comment_sort=top',
      '--',
      url,
    ]);
    expect(subtitleArgs(url, NODE, { language: 'en', auto: false, outTemplate: '/tmp/d/sub.%(ext)s' }).slice(7)).toEqual([
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--write-subs',
      '--sub-langs',
      'en',
      '--sub-format',
      'vtt/srt/best',
      '--convert-subs',
      'vtt',
      '-o',
      '/tmp/d/sub.%(ext)s',
      '--',
      url,
    ]);
    expect(subtitleArgs(url, DENO, { language: 'en-orig', auto: true, outTemplate: 'o' })).toContain('--write-auto-subs');
    expect(subtitleArgs(url, DENO, { language: 'en', auto: true, outTemplate: 'o' })).not.toContain('--convert-subs');
    expect(audioArgs(url, NODE, '/tmp/a/audio.%(ext)s').slice(7)).toEqual([
      '--no-playlist',
      '--no-warnings',
      '-f',
      'bestaudio/best',
      '-x',
      '--audio-format',
      'mp3',
      '--postprocessor-args',
      'ffmpeg:-ac 1 -ar 16000 -b:a 32k',
      '-o',
      '/tmp/a/audio.%(ext)s',
      '--print',
      'after_move:%(duration)s',
      '--',
      url,
    ]);
  });

  it('always ends with -- and the URL', () => {
    for (const args of [
      metadataArgs(url, NODE),
      playlistArgs(url, NODE),
      commentsArgs(url, NODE, 1),
      audioArgs(url, NODE, 'o'),
    ]) {
      expect(args.at(-2)).toBe('--');
      expect(args.at(-1)).toBe(url);
      expect(args.filter((a) => a === '--')).toHaveLength(1);
    }
  });

  it('rejects inputs that could be read as options or are not http(s)', () => {
    for (const bad of ['-o/tmp/x', '--exec=rm', ' -x', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      expect(() => safeUrl(bad)).toThrow(Vid2ContextError);
      expect(() => metadataArgs(bad, NODE)).toThrow(/http|"-"|URL/);
    }
  });

  it('uses per-step timeouts unless YTDLP_TIMEOUT_SEC is set', () => {
    expect(timeoutMs({}, 'metadata')).toBe(60_000);
    expect(timeoutMs({}, 'audio')).toBe(300_000);
    expect(timeoutMs({ YTDLP_TIMEOUT_SEC: '900' }, 'audio')).toBe(900_000);
    expect(timeoutMs({ YTDLP_TIMEOUT_SEC: 'x' }, 'metadata')).toBe(60_000);
  });
});

describe('metadata mapping', () => {
  it('maps a YouTube -J dump', () => {
    const r = ref('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    const m = toMetadata(r, info('info-youtube-jNQXAC9IVRw.json'));
    expect(m.ref).toBe(r);
    expect(m.title).toBe('Me at the zoo');
    expect(m.channel).toEqual({
      name: 'jawed',
      id: 'UC4QobU6STFB0P71PMvOGN5A',
      url: 'https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A',
    });
    expect(m.durationSec).toBe(19);
    expect(m.publishedAt).toBe('2005-04-24T03:31:52.000Z');
    expect(m.chapters).toHaveLength(3);
    expect(m.chapters[0]).toMatchObject({ startSec: 0 });
    expect(m.chapters[0]?.endSec).toBeGreaterThan(0);
    expect(m.thumbnailUrl).toMatch(/^https:\/\/i\.ytimg\.com\/vi\/jNQXAC9IVRw\//);
    expect(m.tags).toHaveLength(3);
    expect(m.isLive).toBe(false);
    expect(m.extra).toMatchObject({
      extractor: 'Youtube',
      webpageUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      extractorId: 'jNQXAC9IVRw',
    });
  });

  it('maps a Vimeo -J dump', () => {
    const r = ref('https://vimeo.com/76979871');
    const m = toMetadata(r, info('info-vimeo-76979871.json'));
    expect(m.title).toBe('The New Vimeo Player (You Know, For Videos)');
    expect(m.channel).toEqual({ name: 'Vimeo', id: 'staff', url: 'https://vimeo.com/staff' });
    expect(m.durationSec).toBe(62);
    expect(m.language).toBe('en');
    expect(m.chapters).toEqual([]);
    expect(m.publishedAt).toBeUndefined();
    expect(m.thumbnailUrl).toMatch(/^https:\/\/i\.vimeocdn\.com\//);
    expect(m.extra).toMatchObject({
      extractor: 'Vimeo',
      webpageUrl: 'https://player.vimeo.com/video/76979871',
      extractorId: '76979871',
    });
  });

  it('maps a TED -J dump, with upload_date as an ISO date', () => {
    const m = toMetadata(ref('https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity'), info('info-ted-66.json'));
    expect(m.title).toMatch(/schools kill creativity/i);
    expect(m.channel?.name).toBe('Sir Ken Robinson');
    expect(m.durationSec).toBe(1151);
    expect(m.publishedAt).toBe('2006-06-27');
    expect(m.tags?.length).toBe(7);
    expect(m.extra?.extractor).toBe('TedTalk');
  });

  it('turns --flat-playlist entries into refs in order', () => {
    const pl = info('flat-playlist-youtube.json');
    const refs = (pl.entries ?? []).map((e) => (e ? entryRef(e) : null));
    expect(refs).toHaveLength(5);
    expect(refs[0]?.id).toBe('youtube:MMxFDaIOHsE');
    expect(refs.every((r) => r?.platform === 'youtube' && r.kind === 'video')).toBe(true);
  });

  it('builds a comment tree with replies, creator and pinned flags, bounded by limit', () => {
    const raw = JSON.parse(fixture('comments-youtube-jNQXAC9IVRw.json')) as { comments: NonNullable<YtDlpInfo['comments']> };
    const tree = toComments(raw.comments, 100);
    expect(tree).toHaveLength(4);
    expect(tree[0]).toMatchObject({ author: '@SanDiegoZoo', isPinned: true, publishedAt: '2020-11-15T00:00:00.000Z' });
    expect(tree[0]?.replies).toHaveLength(2);
    expect(tree.find((c) => c.author === '@jawed')?.isCreator).toBe(true);
    const capped = toComments(raw.comments, 2);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.replies).toHaveLength(1);
  });

  it('parses JSON stdout and rejects anything else', () => {
    expect(parseJson(fixture('info-vimeo-76979871.json'), 'x').id).toBe('76979871');
    expect(() => parseJson('ERROR: nope', 'x')).toThrow(/did not print JSON/);
  });
});

describe('subtitles', () => {
  it('parses a real Vimeo WebVTT file', () => {
    const segs = parseVtt(fixture('subs-vimeo-76979871.en.vtt'));
    expect(segs[0]).toEqual({
      startSec: 5.237,
      endSec: 8.043,
      text: "Here at Vimeo, there's always one thing on our minds:",
    });
    expect(segs.every((s) => !/[<>]/.test(s.text))).toBe(true);
    expect(segs.every((s, i) => i === 0 || s.startSec >= (segs[i - 1]?.startSec ?? 0))).toBe(true);
  });

  it('reads the same file with CRLF line endings and a BOM', () => {
    const vtt = fixture('subs-vimeo-76979871.en.vtt');
    expect(parseVtt(`﻿${vtt.replace(/\n/g, '\r\n')}`)).toEqual(parseVtt(vtt));
  });

  it('chooses creator tracks, honours language and allowAuto', () => {
    const vimeo = info('info-vimeo-76979871.json');
    expect(chooseSubtitle(vimeo, {})).toEqual({ key: 'en', language: 'en', auto: false, translated: false });
    expect(chooseSubtitle(vimeo, { language: 'de' })?.key).toBe('de');
    expect(chooseSubtitle(vimeo, { language: 'ja' })).toBeNull();

    const ted = info('info-ted-66.json');
    expect(chooseSubtitle(ted, { language: 'pt-BR' })?.key).toBe('pt-br');
    expect(chooseSubtitle(ted, {})?.key).toBe('en');

    const yt = info('info-youtube-jNQXAC9IVRw.json');
    expect(chooseSubtitle(yt, {})).toMatchObject({ key: 'en', auto: false });
    expect(chooseSubtitle({ ...yt, subtitles: {} }, { allowAuto: false })).toBeNull();
    expect(chooseSubtitle({ ...yt, subtitles: {} }, { language: 'de' })).toMatchObject({ key: 'de', auto: true });
    expect(listTracks(vimeo).map((t) => t.language)).toEqual(['es', 'en', 'fr', 'de']);
  });
});

describe('stderr mapping', () => {
  it('maps real yt-dlp errors to codes with hints', () => {
    const cases: [string, string][] = [
      ['stderr-unsupported-url.txt', 'unsupported-input'],
      ['stderr-video-unavailable.txt', 'not-found'],
      ['stderr-subtitles-429.txt', 'rate-limited'],
      ['stderr-vimeo-login.txt', 'auth'],
    ];
    for (const [file, code] of cases) {
      const err = errorFromStderr(fixture(file), 'yt-dlp metadata', 1);
      expect(err.code, file).toBe(code);
      expect(err.hint, file).toBeTruthy();
      expect(err.message.startsWith('yt-dlp metadata: ')).toBe(true);
      expect(err.message).not.toContain('ERROR:');
    }
  });

  it('falls back to upstream with the exit code when stderr is empty', () => {
    const err = errorFromStderr('', 'yt-dlp audio', 2);
    expect(err.code).toBe('upstream');
    expect(err.message).toContain('code 2');
  });
});

describe('binary management (no network)', () => {
  it('parses the real SHA2-256SUMS and knows the asset for this platform', () => {
    const sums = parseSums(fixture('SHA2-256SUMS-2026.10.26.txt'));
    expect(sums.get('yt-dlp_linux')).toBe('767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795');
    expect(sums.get('yt-dlp_macos')).toMatch(/^[0-9a-f]{64}$/);
    expect(assetName('linux', 'x64')).toBe('yt-dlp_linux');
    expect(assetName('linux', 'arm64')).toBe('yt-dlp_linux_aarch64');
    expect(assetName('darwin', 'arm64')).toBe('yt-dlp_macos');
    expect(assetName('win32', 'x64')).toBe('yt-dlp.exe');
    expect(assetName('freebsd', 'x64')).toBeNull();
    for (const a of ['yt-dlp_linux', 'yt-dlp_linux_aarch64', 'yt-dlp_macos', 'yt-dlp.exe', 'yt-dlp_arm64.exe'])
      expect(sums.has(a)).toBe(true);
  });

  it('reads the latest tag from the recorded releases/latest redirect', async () => {
    const head = fixture('releases-latest-head.txt');
    const location = /location: (\S+)/.exec(head)?.[1] ?? '';
    const fetch = replayFetch([
      {
        method: 'HEAD',
        url: 'https://github.com/yt-dlp/yt-dlp/releases/latest',
        response: { status: 302, headers: { location }, body: '' },
      },
    ]);
    expect(await latestTag(testContext({ fetch }))).toBe('2026.10.26');
  });

  it('serializes concurrent holders of the install lock and cleans it up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vid2context-ytdlp-lock-'));
    const file = join(dir, 'locks', 'ytdlp');
    const ctx = testContext();
    const events: string[] = [];
    const hold = (name: string) =>
      withLock(
        file,
        async () => {
          events.push(`${name}:in`);
          await new Promise((r) => setTimeout(r, 100));
          events.push(`${name}:out`);
        },
        ctx,
      );
    try {
      await Promise.all([hold('a'), hold('b')]);
      expect(events).toHaveLength(4);
      expect(events[0]?.endsWith(':in') && events[1]?.endsWith(':out')).toBe(true);
      expect(events[0]?.split(':')[0]).toBe(events[1]?.split(':')[0]);
      await expect(stat(file)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('takes over a lock left by a dead process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vid2context-ytdlp-lock-'));
    const file = join(dir, 'ytdlp');
    try {
      const { writeFile } = await import('node:fs/promises');
      const { hostname } = await import('node:os');
      await writeFile(file, JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), at: Date.now() }));
      const got = await withLock(file, async () => readFile(file, 'utf8'), testContext());
      expect(JSON.parse(got).pid).toBe(process.pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('process runner', () => {
  const node = process.execPath;

  it('captures stdout and exit codes without a shell', async () => {
    const res = await run(node, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected) && ; |'], testContext(), {
      timeoutMs: 10_000,
      label: 'test',
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('$(echo injected) && ; |');
  });

  it('keeps only the tail of stderr', async () => {
    const res = await run(node, ['-e', 'process.stderr.write("x".repeat(200000) + "ERROR: last")'], testContext(), {
      timeoutMs: 10_000,
      label: 'test',
      maxStderr: 1000,
    });
    expect(res.stderr.length).toBeLessThanOrEqual(1000);
    expect(res.stderr.endsWith('ERROR: last')).toBe(true);
  });

  it('times out and kills the child', async () => {
    const started = Date.now();
    await expect(
      run(node, ['-e', 'setTimeout(() => {}, 60000)'], testContext(), { timeoutMs: 300, label: 'test' }),
    ).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('kills the process tree on abort', async () => {
    const ac = new AbortController();
    // The child spawns a grandchild and prints its pid; abort must kill both.
    const script =
      "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});console.log(c.pid);setTimeout(()=>{},60000)";
    const ctx = testContext({ signal: ac.signal });
    const p = run(node, ['-e', script], ctx, { timeoutMs: 30_000, label: 'test' });
    await new Promise((r) => setTimeout(r, 500));
    ac.abort();
    await expect(p).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // We cannot read the grandchild pid from a rejected run, so check no node child of ours with that script survives.
    const { execFileSync } = await import('node:child_process');
    const ps = execFileSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8' });
    const survivors = ps.split('\n').filter((l) => l.includes('setTimeout(()=>{},60000)') && !l.includes('ps -eo'));
    expect(survivors.filter((l) => alive(Number(l.trim().split(/\s+/)[0])))).toEqual([]);
  });

  it('reports a missing binary as no-provider', async () => {
    await expect(
      run('/nonexistent/yt-dlp', ['--version'], testContext(), { timeoutMs: 5000, label: 'test' }),
    ).rejects.toMatchObject({
      code: 'no-provider',
    });
  });
});

describe.skipIf(!process.env.LIVE)('live', () => {
  it('installs the managed binary into a temp VID2CONTEXT_HOME once, even with two concurrent callers', async () => {
    const { ensureYtDlp } = await import('../src/binary.ts');
    const home = await mkdtemp(join(tmpdir(), 'vid2context-ytdlp-home-'));
    // A PATH without yt-dlp forces the managed install.
    const env = { ...process.env, VID2CONTEXT_HOME: home, YTDLP_PATH: '', PATH: '/usr/bin:/bin' };
    const ctx = createContext({ runtime: 'node', env });
    try {
      const [a, b] = await Promise.all([ensureYtDlp(ctx), ensureYtDlp(createContext({ runtime: 'node', env: { ...env } }))]);
      expect(a.managed).toBe(true);
      expect(a.path).toBe(join(home, 'bin', 'yt-dlp'));
      expect(b.path).toBe(a.path);
      expect(a.version).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
      const meta = JSON.parse(await readFile(join(home, 'bin', 'yt-dlp.json'), 'utf8'));
      const { createHash } = await import('node:crypto');
      expect(
        createHash('sha256')
          .update(await readFile(a.path))
          .digest('hex'),
      ).toBe(meta.sha256);
      await expect(stat(join(home, 'locks', 'ytdlp'))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 300_000);

  it('fetches metadata, captions and audio for a short public video, and transcribes it through the keyless chain', async () => {
    const { ytdlpCaptions, ytdlpSource } = await import('../src/index.ts');
    const { getVideoContext, Registry } = await import('@vid2context/core');
    const stt = (await import('@vid2context/provider-stt-openai-compatible')).default;
    const ctx = createContext({ runtime: 'node', env: process.env });

    const vimeo = ref('https://vimeo.com/76979871');
    const meta = await ytdlpSource.getMetadata(vimeo, ctx);
    expect(meta.title).toMatch(/Vimeo Player/);
    const subs = await ytdlpCaptions.getCaptions(vimeo, {}, ctx);
    expect(subs?.origin).toBe('creator-captions');
    expect(subs?.segments.length).toBeGreaterThan(5);

    const yt = ref('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    const audio = await ytdlpSource.getAudio?.(yt, ctx);
    expect(audio?.kind).toBe('bytes');
    if (audio?.kind === 'bytes') {
      expect(audio.mimeType).toBe('audio/mpeg');
      expect(audio.data.byteLength).toBeGreaterThan(20_000);
      expect(audio.durationSec).toBeCloseTo(19, 0);
    }

    const context = await getVideoContext(
      new Registry([ytdlpSource, ytdlpCaptions, ...[stt].flat()], 'node'),
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      { mode: 'stt' },
      ctx,
    );
    expect(context.transcript.origin).toBe('stt');
    expect(context.attempts.find((a) => a.stage === 'audio' && a.outcome === 'ok')?.id).toBe('ytdlp');
    expect(context.transcript.segments.map((s) => s.text).join(' ')).toMatch(/elephant/i);
  }, 300_000);
});
