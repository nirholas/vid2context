import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import mediaFile from '../../../../providers/media-file/src/index.ts';
import { expandInput, getVideoContext } from '../../src/pipeline.ts';
import { Registry } from '../../src/registry.ts';
import { checkInput, enforceInputPolicy, isPublicMode, limits, setHostResolver } from '../../src/security/index.ts';
import { replayFetch, testContext } from '../../src/testing.ts';

const PUBLIC = { VID2CONTEXT_PUBLIC: '1' };
const APOLLO = resolve(import.meta.dirname, '../../../../tests/fixtures/media/apollo11-small-step.mp3');

describe('isPublicMode', () => {
  it('reads VID2CONTEXT_PUBLIC', () => {
    expect(isPublicMode({ VID2CONTEXT_PUBLIC: '1' })).toBe(true);
    expect(isPublicMode({ VID2CONTEXT_PUBLIC: 'true' })).toBe(true);
    expect(isPublicMode({ VID2CONTEXT_PUBLIC: '0' })).toBe(false);
    expect(isPublicMode({})).toBe(false);
  });
});

describe('checkInput in public mode', () => {
  const refusedPaths = [
    '/etc/passwd',
    '/proc/self/environ',
    '~/.ssh/id_rsa',
    '~/Movies/talk.mp4',
    './talk.mp4',
    '../../../../etc/shadow',
    '..\\..\\windows\\win.ini',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    'c:/Users/me/video.mkv',
    '\\\\fileserver\\share\\video.mp4',
    'video.mp4',
    'interview.m4a',
    'secrets/keys.txt',
    'file:///etc/passwd',
    'FILE://localhost/etc/passwd',
    'file:/etc/passwd',
  ];
  for (const input of refusedPaths) {
    it(`refuses the local path ${input}`, () => {
      const err = checkInput(input, PUBLIC);
      expect(err?.code).toBe('unsupported-input');
      expect(err?.hint).toMatch(/does not read local files|Upload the file/);
    });
  }

  const refusedUrls = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8787/api/v1/health',
    'http://[::1]/',
    'http://2130706433/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://user:pass@example.com/video.mp4',
    'gopher://localhost:25/_HELO',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'ftp://example.com/a.mp3',
    '127.0.0.1/admin',
    'localhost:8080/x',
    '169.254.169.254/latest/meta-data/',
    '[::1]:22/',
  ];
  for (const input of refusedUrls) {
    it(`refuses the URL ${input}`, () => {
      const err = checkInput(input, PUBLIC);
      expect(err?.code).toBe('unsupported-input');
      expect(err?.hint).toBeTruthy();
    });
  }

  const allowed = [
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'https://youtu.be/jNQXAC9IVRw',
    'youtu.be/jNQXAC9IVRw',
    'www.youtube.com/watch?v=jNQXAC9IVRw',
    'jNQXAC9IVRw',
    'https://vimeo.com/76979871',
    'https://feeds.simplecast.com/54nAGcIl',
    'ytsearch5:apollo 11 landing',
    '  https://www.youtube.com/watch?v=jNQXAC9IVRw  ',
  ];
  for (const input of allowed) {
    it(`allows ${input.trim()}`, () => {
      expect(checkInput(input, PUBLIC)).toBeUndefined();
    });
  }

  it('refuses inputs longer than the limit, and the limit follows env', () => {
    const long = `https://www.youtube.com/watch?v=jNQXAC9IVRw&x=${'a'.repeat(limits().maxInputChars)}`;
    expect(checkInput(long, PUBLIC)?.message).toContain('the limit is 2048');
    expect(checkInput('https://youtu.be/jNQXAC9IVRw', { ...PUBLIC, VID2CONTEXT_MAX_INPUT_CHARS: '10' })?.code).toBe(
      'unsupported-input',
    );
  });

  it('refuses control characters', () => {
    expect(checkInput('https://youtu.be/x\r\nHost: 169.254.169.254', PUBLIC)?.code).toBe('unsupported-input');
  });

  it('allows everything outside public mode (local use reads local files by design)', () => {
    expect(checkInput('/etc/passwd', {})).toBeUndefined();
    expect(checkInput('http://127.0.0.1/', {})).toBeUndefined();
  });
});

describe('enforceInputPolicy with a registered resolver', () => {
  afterEach(() => setHostResolver(undefined));

  it('refuses a public name that resolves to the metadata address (recorded answer)', async () => {
    setHostResolver(async (h) => (h === '169.254.169.254.nip.io' ? ['169.254.169.254'] : []));
    await expect(enforceInputPolicy('http://169.254.169.254.nip.io/latest/', testContext({ env: PUBLIC }))).rejects.toMatchObject(
      { code: 'unsupported-input' },
    );
  });

  it('does nothing outside public mode', async () => {
    setHostResolver(async () => ['127.0.0.1']);
    await expect(enforceInputPolicy('http://localtest.me/', testContext({ env: {} }))).resolves.toBeUndefined();
  });
});

describe('pipeline integration', () => {
  const registry = new Registry([mediaFile], 'node');

  it('the media-file provider would accept the shared fixture path outside public mode', () => {
    expect(registry.resolve(APOLLO).source.id).toBe(mediaFile.id);
  });

  it('getVideoContext refuses a local path in public mode before any provider runs', async () => {
    const fetch = replayFetch([]);
    const err = await getVideoContext(registry, APOLLO, {}, testContext({ env: PUBLIC, fetch })).catch((e) => e);
    expect(err.code).toBe('unsupported-input');
    expect(err.message).toContain('Local file paths are not accepted');
    expect(err.attempts).toBeUndefined();
    expect(fetch.calls).toHaveLength(0);
  });

  it('getVideoContext refuses file:// in public mode', async () => {
    const err = await getVideoContext(registry, `file://${APOLLO}`, {}, testContext({ env: PUBLIC })).catch((e) => e);
    expect(err.code).toBe('unsupported-input');
    expect(err.message).toContain('file://');
  });

  it('expandInput refuses private URLs in public mode', async () => {
    const err = await expandInput(registry, 'http://192.168.1.1/feed.xml', testContext({ env: PUBLIC })).catch((e) => e);
    expect(err.code).toBe('unsupported-input');
    expect(err.message).toContain('private');
  });
});
