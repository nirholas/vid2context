import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, getVideoContext, Registry, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type RecordedResponse, replayFetch, testContext } from '@vid2context/core/testing';
import sttOpenAiCompatible from '@vid2context/provider-stt-openai-compatible';
import { describe, expect, it } from 'vitest';
import { dispositionFilename } from '../src/files.ts';
import { confirmUrlFromInterstitial } from '../src/gdrive.ts';
import { shareLinks } from '../src/index.ts';
import { encodeShareId, sharePointDownloadUrl } from '../src/onedrive.ts';
import { matchShareLink, parseSharePoint } from '../src/url.ts';

// Fixtures are real recordings (see test/fixtures/README.md).
interface Fixture {
  request: { method: string; url: string };
  status: number;
  headers: Record<string, string>;
  body: string;
}
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'));
const recorded = (name: string): RecordedResponse => {
  const f = fixture(name);
  return { status: f.status, headers: f.headers, body: f.body };
};
const route = (name: string) => ({
  method: fixture(name).request.method,
  url: fixture(name).request.url,
  response: recorded(name),
});

const ref = (input: string): VideoRef => {
  const r = matchShareLink(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
};

async function rejection(p: Promise<unknown>): Promise<Vid2ContextError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Vid2ContextError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

const DRIVE_VOICE = 'https://drive.google.com/file/d/1ucJCfKfKr00_09H8_FmW57xFYHYPzC2h/view?usp=share_link';
const DRIVE_BBB = 'https://drive.google.com/file/d/0ByeS4oOUV-49Zzh4R1J6R09zazQ/edit?pli=1';
const DRIVE_GONE = 'https://drive.google.com/uc?id=1IP0o8dHcQrIHGgVyp0Ofvx2cGfLzyO1x';
const DROPBOX_TAPESTRY = 'https://www.dropbox.com/s/qte66a7haqspq2g/tapestry.wav?dl=1';
const ONEDRIVE_VIDEO = 'https://1drv.ms/v/c/7be8ecfc440137f7/IQAJInfVpuT2ToNqGbJ8iY87AY8SUyORWpN20ws6qYMlI5I';
const ONEDRIVE_CHECKPOINT = 'https://1drv.ms/u/s!AqeByhGUtINrgcsFdbjgcEuDhwN3vg?e=EF3usb';
const SHAREPOINT_SITE =
  'https://greaternyace.sharepoint.com/:v:/s/acementornydrive/ETski5eAfNVEoPRZUAyy1wEBpLgVFYWso5bjbZjfBLlPUg?e=PQUfVb';
const SHAREPOINT_ROOT = 'https://izoobasisschool.sharepoint.com/:v:/g/Eaqleq8COVBIvIPvod0U27oBypC6aWOkk8ptuDpmJ6arHw';

describe('matchShareLink', () => {
  it.each([
    [DRIVE_VOICE, 'gdrive:1ucJCfKfKr00_09H8_FmW57xFYHYPzC2h'],
    [DRIVE_BBB, 'gdrive:0ByeS4oOUV-49Zzh4R1J6R09zazQ'],
    ['https://drive.google.com/open?id=0B2fjwgkl1A_CX083Tkowdmt6d28', 'gdrive:0B2fjwgkl1A_CX083Tkowdmt6d28'],
    ['https://drive.google.com/uc?id=0B2fjwgkl1A_CX083Tkowdmt6d28&export=download', 'gdrive:0B2fjwgkl1A_CX083Tkowdmt6d28'],
    ['https://drive.google.com/u/0/uc?id=19oAw8wWn3Y7z6CKChRdAyGOB9yupL_Xt', 'gdrive:19oAw8wWn3Y7z6CKChRdAyGOB9yupL_Xt'],
    ['https://drive.usercontent.google.com/download?id=0ByeS4oOUV-49Zzh4R1J6R09zazQ', 'gdrive:0ByeS4oOUV-49Zzh4R1J6R09zazQ'],
    ['drive.google.com/file/d/1ENcQ_jeCuj7y19s66_Ou9dRP4GKGsodiDQ/edit', 'gdrive:1ENcQ_jeCuj7y19s66_Ou9dRP4GKGsodiDQ'],
    [DROPBOX_TAPESTRY, 'dropbox:qte66a7haqspq2g'],
    ['https://www.dropbox.com/s/nelirfsxnmcfbfh', 'dropbox:nelirfsxnmcfbfh'],
    [
      'https://www.dropbox.com/scl/fi/r2kd2skcy5ylbbta5y1pz/DJI_0003.MP4?dl=0&rlkey=wcdgqangn7t3lnmmv6li9mu9h',
      'dropbox:r2kd2skcy5ylbbta5y1pz',
    ],
    [
      'https://www.dropbox.com/e/scl/fi/r2kd2skcy5ylbbta5y1pz/DJI_0003.MP4?dl=0&rlkey=wcdgqangn7t3lnmmv6li9mu9h',
      'dropbox:r2kd2skcy5ylbbta5y1pz',
    ],
    [ONEDRIVE_VIDEO, 'onedrive:IQAJInfVpuT2ToNqGbJ8iY87AY8SUyORWpN20ws6qYMlI5I'],
    [ONEDRIVE_CHECKPOINT, 'onedrive:s!AqeByhGUtINrgcsFdbjgcEuDhwN3vg'],
    [SHAREPOINT_SITE, 'onedrive:ETski5eAfNVEoPRZUAyy1wEBpLgVFYWso5bjbZjfBLlPUg'],
    [SHAREPOINT_ROOT, 'onedrive:Eaqleq8COVBIvIPvod0U27oBypC6aWOkk8ptuDpmJ6arHw'],
    [
      'https://microsoft.sharepoint.com/:v:/t/MicrosoftSPARKRecordings-MSFTInternal/EWCyeqByVWBAt8wDvNZdV-UB0BvU5YVbKm0UHgdrUlI6dg?e=QbPck6',
      'onedrive:EWCyeqByVWBAt8wDvNZdV-UB0BvU5YVbKm0UHgdrUlI6dg',
    ],
  ])('%s -> %s', (input, id) => {
    expect(matchShareLink(input)?.id).toBe(id);
  });

  it('builds canonical refs that keep what the download needs', () => {
    expect(ref(DRIVE_VOICE)).toEqual({
      input: DRIVE_VOICE,
      platform: 'gdrive',
      kind: 'video',
      id: 'gdrive:1ucJCfKfKr00_09H8_FmW57xFYHYPzC2h',
      nativeId: '1ucJCfKfKr00_09H8_FmW57xFYHYPzC2h',
      url: 'https://drive.google.com/file/d/1ucJCfKfKr00_09H8_FmW57xFYHYPzC2h/view',
    });
    expect(ref('https://drive.google.com/file/d/0B-vUyvmDLdWDcEt4WjBqcmI2XzQ/view?resourcekey=0-abc').url).toBe(
      'https://drive.google.com/file/d/0B-vUyvmDLdWDcEt4WjBqcmI2XzQ/view?resourcekey=0-abc',
    );
    expect(
      ref('https://www.dropbox.com/scl/fi/r2kd2skcy5ylbbta5y1pz/DJI_0003.MP4?dl=0&rlkey=wcdgqangn7t3lnmmv6li9mu9h').url,
    ).toBe('https://www.dropbox.com/scl/fi/r2kd2skcy5ylbbta5y1pz/DJI_0003.MP4?rlkey=wcdgqangn7t3lnmmv6li9mu9h');
    expect(ref(ONEDRIVE_CHECKPOINT).url).toBe(ONEDRIVE_CHECKPOINT);
  });

  it('unwraps the share link that onedrive.live.com redirects carry in redeem=', () => {
    // The Location header 1drv.ms answered for ONEDRIVE_CHECKPOINT on 2026-11-14.
    const redirect =
      'https://onedrive.live.com/:u:/g/personal/6B83B49411CA81A7/s!AqeByhGUtINrgcsFdbjgcEuDhwN3vg?resid=6B83B49411CA81A7!25989&e=EF3usb&migratedtospo=true&redeem=aHR0cHM6Ly8xZHJ2Lm1zL3UvcyFBcWVCeWhHVXRJTnJnY3NGZGJqZ2NFdURod04zdmc_ZT1FRjN1c2I';
    expect(ref(redirect)).toMatchObject({ platform: 'onedrive', url: ONEDRIVE_CHECKPOINT });
  });

  it('rejects folders and other URLs', () => {
    for (const input of [
      'https://drive.google.com/drive/folders/1dQ4sx0-__Nvg65rxTSgQrl7VyW_FZ9QI',
      'https://www.dropbox.com/sh/2mgpiuq7kv8nqdf/AABy-fW4dkydT4GmWi2mdOUDa?dl=0&preview=Drone+Shot.mp4',
      'https://www.dropbox.com/scl/fo/zjfqse5txqfd7twa8iewj/AOfZzSYWUSKle2HD7XF7kzQ/A-BEAT%20C.mp4?rlkey=6tg3jkp4tv6a5vt58a6dag0mm&dl=0',
      'https://1drv.ms/f/s!Av15ztErtQLrlFSNvhIzIsAi3KJy',
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      'https://docs.google.com/document/d/1ucJCfKfKr00_09H8_FmW57xFYHYPzC2h/edit',
      'jNQXAC9IVRw',
      '/home/user/talk.mp3',
    ]) {
      expect(matchShareLink(input), input).toBeNull();
    }
  });
});

describe('SharePoint and OneDrive helpers', () => {
  it('maps sharing links to the anonymous download endpoint', () => {
    expect(parseSharePoint(SHAREPOINT_SITE)).toEqual({
      host: 'greaternyace.sharepoint.com',
      sitePath: 'sites/acementornydrive',
      token: 'ETski5eAfNVEoPRZUAyy1wEBpLgVFYWso5bjbZjfBLlPUg',
    });
    expect(sharePointDownloadUrl(SHAREPOINT_SITE)).toBe(fixture('sharepoint-download').request.url);
    expect(sharePointDownloadUrl(SHAREPOINT_ROOT)).toBe(fixture('sharepoint-error-page').request.url);
    expect(sharePointDownloadUrl(ONEDRIVE_VIDEO)).toBeNull();
  });

  it('encodes share ids the way the shares API expects', () => {
    expect(`${encodeShareId(ONEDRIVE_VIDEO)}`).toBe(
      fixture('onedrive-driveitem-video').request.url.split('/shares/')[1]?.split('/')[0],
    );
  });

  it('reads Content-Disposition filenames from real headers', () => {
    expect(dispositionFilename(fixture('dropbox-tapestry').headers['content-disposition'] ?? null)).toBe('tapestry.wav');
    expect(dispositionFilename(fixture('gdrive-bbb-confirmed').headers['content-disposition'] ?? null)).toBe(
      'Big Buck Bunny.mp4',
    );
    expect(dispositionFilename(fixture('onedrive-download-video').headers['content-disposition'] ?? null)).toBe(
      '绿灯才能过马路哦.mp4',
    );
    expect(dispositionFilename('attachment; filename=unspecified')).toBeUndefined();
    expect(dispositionFilename(null)).toBeUndefined();
  });
});

describe('Google Drive', () => {
  it('reads name, size and type from a one-byte ranged GET and hands STT a direct URL', async () => {
    const fetch = replayFetch([route('gdrive-voice')]);
    const ctx = testContext({ fetch });
    const meta = await shareLinks.getMetadata(ref(DRIVE_VOICE), ctx);
    expect(meta.title).toBe('voice');
    expect(meta.extra).toMatchObject({
      service: 'Google Drive',
      filename: 'voice.mp3',
      sizeBytes: 265822,
      mimeType: 'audio/mpeg',
    });
    expect(await shareLinks.getAudio?.(ref(DRIVE_VOICE), ctx)).toEqual({
      kind: 'url',
      url: fixture('gdrive-voice').request.url,
      mimeType: 'audio/mpeg',
    });
    // getMetadata and getAudio share one resolution per ctx.
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.headers.range).toBe('bytes=0-0');
  });

  it('follows the virus-scan confirmation form for large files, then refuses files above the cap', async () => {
    const interstitial = fixture('gdrive-bbb-interstitial');
    const confirmed = confirmUrlFromInterstitial(interstitial.body);
    expect(confirmed).toMatch(
      /^https:\/\/drive\.usercontent\.google\.com\/download\?id=0ByeS4oOUV-49Zzh4R1J6R09zazQ&export=download&confirm=t&uuid=/,
    );
    const fetch = replayFetch([
      { url: /confirm=t/, response: recorded('gdrive-bbb-confirmed') },
      route('gdrive-bbb-interstitial'),
    ]);
    const ctx = testContext({ fetch });
    const meta = await shareLinks.getMetadata(ref(DRIVE_BBB), ctx);
    expect(meta.title).toBe('Big Buck Bunny');
    expect(meta.extra).toMatchObject({ sizeBytes: 185972864, mimeType: 'video/mp4' });
    const err = await rejection(shareLinks.getAudio?.(ref(DRIVE_BBB), ctx) ?? Promise.resolve());
    expect(err.code).toBe('too-large');
    expect(err.message).toContain('177.4 MB');
    expect(err.hint).toContain('item 04');
    expect(err.hint).toContain('SHARE_LINKS_MAX_MB');
  });

  it('maps a deleted or unshared file to not-found with a sharing hint', async () => {
    const ctx = testContext({ fetch: replayFetch([route('gdrive-not-found')]) });
    const err = await rejection(shareLinks.getMetadata(ref(DRIVE_GONE), ctx));
    expect(err.code).toBe('not-found');
    expect(err.hint).toContain('Anyone with the link');
  });
});

describe('Dropbox', () => {
  it('uses dl=1, takes the type from the extension (Dropbox says application/binary) and returns a URL', async () => {
    const fetch = replayFetch([route('dropbox-tapestry')]);
    const ctx = testContext({ fetch });
    const r = ref(DROPBOX_TAPESTRY);
    const meta = await shareLinks.getMetadata(r, ctx);
    expect(meta).toMatchObject({
      title: 'tapestry',
      extra: { filename: 'tapestry.wav', sizeBytes: 100806, mimeType: 'audio/wav' },
    });
    expect(await shareLinks.getAudio?.(r, ctx)).toEqual({ kind: 'url', url: DROPBOX_TAPESTRY, mimeType: 'audio/wav' });
  });

  it.each([
    ['dropbox-invalid-link', 'not-found', 'deleted'],
    ['dropbox-disabled', 'unavailable', 'too much traffic'],
    ['dropbox-no-rlkey', 'unavailable', 'rlkey'],
  ])('maps the %s page to %s', async (name, code, hint) => {
    const f = fixture(name);
    const ctx = testContext({ fetch: replayFetch([route(name)]) });
    const err = await rejection(shareLinks.getMetadata(ref(f.request.url), ctx));
    expect(err.code).toBe(code);
    expect(err.hint).toContain(hint);
  });
});

describe('OneDrive', () => {
  const badger = route('onedrive-badger-token');

  it('reads the shared item with an anonymous viewer token and returns its pre-authenticated download URL', async () => {
    const fetch = replayFetch([badger, route('onedrive-driveitem-video')]);
    const ctx = testContext({ fetch });
    const r = ref(ONEDRIVE_VIDEO);
    const meta = await shareLinks.getMetadata(r, ctx);
    expect(meta).toMatchObject({
      title: '绿灯才能过马路哦',
      durationSec: 53.767,
      extra: { service: 'OneDrive', sizeBytes: 22113859, mimeType: 'video/mp4', width: 800, height: 1334 },
    });
    const audio = await shareLinks.getAudio?.(r, ctx);
    expect(audio).toMatchObject({ kind: 'url', mimeType: 'video/mp4', durationSec: 53.767 });
    expect(audio?.kind === 'url' ? audio.url : '').toContain(
      '/_layouts/15/download.aspx?UniqueId=d5772209-e4a6-4ef6-836a-19b27c898f3b',
    );
    expect(fetch.calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(JSON.parse(String(fetch.calls[0]?.body))).toEqual({ appId: '5cbed6ac-a083-4e14-b191-b4ba07653de2' });
    expect(fetch.calls[1]?.headers).toMatchObject({ authorization: 'Badger [anonymous token removed]', prefer: 'autoredeem' });
  });

  it('refuses files that are not audio or video', async () => {
    const ctx = testContext({ fetch: replayFetch([badger, route('onedrive-driveitem-checkpoint')]) });
    const r = ref(ONEDRIVE_CHECKPOINT);
    expect((await shareLinks.getMetadata(r, ctx)).extra).toMatchObject({ filename: 'speechlmp_large_checkpoint_clean.pt' });
    const err = await rejection(shareLinks.getAudio?.(r, ctx) ?? Promise.resolve());
    expect(err.code).toBe('unsupported-input');
  });

  it.each([
    ['onedrive-link-gone', 'https://1drv.ms/u/s!AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'unavailable'],
    ['onedrive-not-found', 'https://1drv.ms/u/c/6b83b49411ca81a7/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'not-found'],
  ])('maps %s to %s', async (name, link, code) => {
    const ctx = testContext({ fetch: replayFetch([badger, route(name)]) });
    const err = await rejection(shareLinks.getMetadata(ref(link), ctx));
    expect(err.code).toBe(code);
  });
});

describe('SharePoint', () => {
  it('downloads through download.aspx?share= and honours SHARE_LINKS_MAX_MB', async () => {
    const r = ref(SHAREPOINT_SITE);
    const small = testContext({ fetch: replayFetch([route('sharepoint-download')]) });
    expect((await shareLinks.getMetadata(r, small)).extra).toMatchObject({
      filename: '930103681233985536.mp4',
      sizeBytes: 351866951,
    });
    expect((await rejection(shareLinks.getAudio?.(r, small) ?? Promise.resolve())).code).toBe('too-large');

    const raised = testContext({ fetch: replayFetch([route('sharepoint-download')]), env: { SHARE_LINKS_MAX_MB: '400' } });
    expect(await shareLinks.getAudio?.(r, raised)).toEqual({
      kind: 'url',
      url: fixture('sharepoint-download').request.url,
      mimeType: 'video/mp4',
    });
  });

  it('maps an HTML answer (expired or members-only link) to unavailable', async () => {
    const ctx = testContext({ fetch: replayFetch([route('sharepoint-error-page')]) });
    const err = await rejection(shareLinks.getMetadata(ref(SHAREPOINT_ROOT), ctx));
    expect(err.code).toBe('unavailable');
    expect(err.message).toContain('Fout');
  });
});

describe.skipIf(!process.env.LIVE)('share links (live)', () => {
  const live = () => createContext({ runtime: 'node', env: process.env });

  it('transcribes a public Dropbox recording end to end through the keyless speech-to-text rung', async () => {
    const registry = new Registry([shareLinks, sttOpenAiCompatible], 'node');
    // The keyless OVH lane allows about 2 requests per minute per IP and other jobs may share it,
    // so wait out a 429 (the rung's cooldown is at least 30 s) instead of failing.
    let context: Awaited<ReturnType<typeof getVideoContext>> | undefined;
    for (let attempt = 0; attempt < 5 && !context; attempt++) {
      try {
        context = await getVideoContext(registry, DROPBOX_TAPESTRY, { mode: 'stt', chain: { only: ['ovh'] } }, live());
      } catch (err) {
        const attempts = (err as { attempts?: { reason?: string }[] }).attempts ?? [];
        if (!attempts.some((a) => a.reason?.startsWith('rate-limited') || a.reason === 'cooldown')) throw err;
        await new Promise((resolve) => setTimeout(resolve, 45_000));
      }
    }
    if (!context) throw new Error('the keyless OVH lane stayed rate-limited for five attempts');
    expect(context.transcript.origin).toBe('stt');
    expect(context.transcript.producer).toMatch(/^stt\/ovh\//);
    expect(context.transcript.segments.map((s) => s.text).join(' ')).toMatch(/tapestry/i);
    console.error('[live] dropbox transcript:', context.transcript.segments.map((s) => s.text).join(' '));
  }, 300_000);

  it('resolves Google Drive, the virus-scan flow, OneDrive and SharePoint against the real services', async () => {
    const ctx = live();
    expect((await shareLinks.getMetadata(ref(DRIVE_VOICE), ctx)).extra).toMatchObject({
      filename: 'voice.mp3',
      mimeType: 'audio/mpeg',
    });
    expect((await shareLinks.getMetadata(ref(DRIVE_BBB), ctx)).extra).toMatchObject({ filename: 'Big Buck Bunny.mp4' });
    expect((await shareLinks.getMetadata(ref(ONEDRIVE_VIDEO), ctx)).extra).toMatchObject({ mimeType: 'video/mp4' });
    expect((await shareLinks.getMetadata(ref(SHAREPOINT_SITE), ctx)).extra).toMatchObject({ mimeType: 'video/mp4' });
    expect((await rejection(shareLinks.getMetadata(ref(DRIVE_GONE), ctx))).code).toBe('not-found');
  });
});
