/**
 * Managed ffmpeg download, used only when no ffmpeg is installed.
 *
 * Source: the BtbN/FFmpeg-Builds GitHub releases (static builds of the
 * official FFmpeg release branches). Each release publishes checksums.sha256
 * ("<sha256>  <file name>" per line); the archive is verified against it
 * before anything is extracted. These builds are GPL-licensed (the "-gpl"
 * variants include x264 and x265).
 *
 * Only Linux x64 and arm64 are supported. No macOS or Windows source with a
 * published checksum was found (evermeet.cx publishes GPG signatures only), so
 * those platforms get an install hint instead of a download.
 *
 * A file lock in <home>/locks keeps parallel processes from downloading twice.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Vid2ContextError } from '@vid2context/core';
import { withFileLock } from './lock.ts';
import { locksDir, managedBinDir } from './paths.ts';
import { type FfCtx, runProcess } from './process.ts';

export const BTBN_RELEASE_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';

export type BtbnPlatform = 'linux64' | 'linuxarm64';

export interface BtbnAsset {
  name: string;
  sha256: string;
  /** FFmpeg release branch, e.g. '8.1'. */
  version: string;
  url: string;
}

/** Map Node's platform and arch to a BtbN build name, or null when no checksummed build exists. */
export function btbnPlatform(platform: string = process.platform, arch: string = process.arch): BtbnPlatform | null {
  if (platform !== 'linux') return null;
  if (arch === 'x64') return 'linux64';
  if (arch === 'arm64') return 'linuxarm64';
  return null;
}

function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Pick the newest static GPL release build for a platform from a
 * checksums.sha256 file. Nightly "master" builds are skipped in favour of
 * release branches (ffmpeg-n<ver>-latest-<platform>-gpl-<ver>.tar.xz).
 */
export function pickBtbnAsset(checksums: string, platform: BtbnPlatform): BtbnAsset | null {
  const re = new RegExp(`^([0-9a-f]{64})\\s+\\*?(ffmpeg-n(\\d+(?:\\.\\d+)*)-latest-${platform}-gpl-\\3\\.tar\\.xz)$`);
  let best: BtbnAsset | null = null;
  for (const line of checksums.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m?.[1] || !m[2] || !m[3]) continue;
    if (!best || newerVersion(m[3], best.version)) {
      best = { sha256: m[1], name: m[2], version: m[3], url: `${BTBN_RELEASE_URL}${m[2]}` };
    }
  }
  return best;
}

function unsupported(platform: string, arch: string): Vid2ContextError {
  return new Vid2ContextError('unavailable', `No checksummed ffmpeg download is available for ${platform}/${arch}.`, {
    hint:
      platform === 'darwin'
        ? 'Install ffmpeg with Homebrew (brew install ffmpeg), or set FFMPEG_PATH and FFPROBE_PATH.'
        : platform === 'win32'
          ? 'Install ffmpeg (winget install ffmpeg), or set FFMPEG_PATH and FFPROBE_PATH.'
          : 'Install ffmpeg with your package manager, or set FFMPEG_PATH and FFPROBE_PATH.',
  });
}

async function findBinary(dir: string, name: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name && /[\\/]bin$/.test(entry.parentPath)) return join(entry.parentPath, entry.name);
  }
  return null;
}

/**
 * Download, verify and install ffmpeg and ffprobe into the managed bin
 * directory. Returns their paths. Safe to call from several processes at once.
 */
export async function downloadFfmpeg(
  ctx: FfCtx = {},
  opts: { platform?: string; arch?: string } = {},
): Promise<{ ffmpeg: string; ffprobe: string; version: string }> {
  const env = ctx.env ?? {};
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const plat = btbnPlatform(platform, arch);
  if (!plat) throw unsupported(platform, arch);
  const fetchFn = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  const binDir = managedBinDir(env);
  const ffmpeg = join(binDir, 'ffmpeg');
  const ffprobe = join(binDir, 'ffprobe');

  return withFileLock(
    join(locksDir(env), 'ffmpeg-download.lock'),
    async () => {
      // Another process may have finished the download while we waited.
      if (existsSync(ffmpeg) && existsSync(ffprobe)) return { ffmpeg, ffprobe, version: 'managed' };
      await mkdir(binDir, { recursive: true });

      const sumsRes = await fetchFn(`${BTBN_RELEASE_URL}checksums.sha256`, { signal: ctx.signal, redirect: 'follow' });
      if (!sumsRes.ok) {
        throw new Vid2ContextError('unavailable', `Could not fetch ffmpeg checksums: HTTP ${sumsRes.status}.`, {
          hint: 'Install ffmpeg with your package manager, or retry later.',
        });
      }
      const asset = pickBtbnAsset(await sumsRes.text(), plat);
      if (!asset) {
        throw new Vid2ContextError('unavailable', `No ffmpeg release build for ${plat} is listed in the checksums file.`, {
          hint: 'Install ffmpeg with your package manager.',
        });
      }
      ctx.log?.info('downloading ffmpeg (GPL static build)', { asset: asset.name, url: asset.url });

      const archive = join(binDir, `.ffmpeg-${process.pid}-${randomBytes(4).toString('hex')}.tar.xz`);
      let extractDir: string | undefined;
      try {
        const res = await fetchFn(asset.url, { signal: ctx.signal, redirect: 'follow' });
        if (!res.ok || !res.body) {
          throw new Vid2ContextError('unavailable', `ffmpeg download failed: HTTP ${res.status}.`, {
            hint: 'Install ffmpeg with your package manager, or retry later.',
          });
        }
        const hash = createHash('sha256');
        const hasher = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>),
          hasher,
          createWriteStream(archive),
          ctx.signal ? { signal: ctx.signal } : {},
        );
        if (hash.digest('hex') !== asset.sha256) {
          throw new Vid2ContextError('upstream', `ffmpeg download checksum mismatch for ${asset.name}.`, {
            hint: 'The download was corrupted or tampered with. Retry, or install ffmpeg with your package manager.',
          });
        }

        extractDir = await mkdtemp(join(binDir, '.extract-'));
        await runProcess('tar', ['-xJf', archive, '-C', extractDir], {
          label: 'tar (ffmpeg archive)',
          timeoutMs: 10 * 60_000,
          signal: ctx.signal,
        });
        const srcFfmpeg = await findBinary(extractDir, 'ffmpeg');
        const srcFfprobe = await findBinary(extractDir, 'ffprobe');
        if (!srcFfmpeg || !srcFfprobe) {
          throw new Vid2ContextError('upstream', `The ffmpeg archive ${asset.name} has no bin/ffmpeg and bin/ffprobe.`, {
            hint: 'Install ffmpeg with your package manager.',
          });
        }
        await chmod(srcFfmpeg, 0o755);
        await chmod(srcFfprobe, 0o755);
        await rename(srcFfprobe, ffprobe);
        await rename(srcFfmpeg, ffmpeg);
        const provenance = {
          source: asset.url,
          sha256: asset.sha256,
          version: asset.version,
          license: 'GPL (BtbN/FFmpeg-Builds -gpl static build)',
          installedAt: new Date().toISOString(),
        };
        await writeFile(join(binDir, 'ffmpeg.json'), `${JSON.stringify(provenance, null, 2)}\n`);
        return { ffmpeg, ffprobe, version: asset.version };
      } finally {
        await rm(archive, { force: true });
        if (extractDir) await rm(extractDir, { recursive: true, force: true });
      }
    },
    { signal: ctx.signal },
  );
}
