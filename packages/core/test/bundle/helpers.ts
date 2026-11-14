import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoContext } from '../../src/types.ts';

export function loadContext(file: string): VideoContext {
  return JSON.parse(
    readFileSync(new URL(`../../../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8'),
  ) as VideoContext;
}

/** "Me at the zoo": 19 s, creator captions, three chapters. */
export const zoo = (): VideoContext => loadContext('youtube-jNQXAC9IVRw.json');
/** "Best & Worst G-Wagon Years ...": 18 min, auto-captions, no chapters. */
export const gwagon = (): VideoContext => loadContext('youtube-cCPsdFdlshc.json');

export const hasUnzip = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;

/** Run the system `unzip -t` on the bytes; returns its output. Throws when unzip reports an error. */
export function unzipTest(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2c-zip-'));
  try {
    const file = join(dir, 'bundle.zip');
    writeFileSync(file, bytes);
    return execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}
