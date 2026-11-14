/** Shared by the longform tests and the fixture recorder. */
import { readFileSync } from 'node:fs';
import { scanMp3 } from '@vid2context/core';

export const fixtureDir = new URL('../fixtures/longform/', import.meta.url);

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, fixtureDir)));
}

/** The first whole MP3 frames covering at most `sec` seconds (frame-exact, no re-encoding). */
export function firstSeconds(data: Uint8Array, sec: number): Uint8Array {
  const f = scanMp3(data);
  let n = 0;
  while (n < f.offsets.length && (f.times[n + 1] as number) <= sec) n++;
  const start = f.offsets[0] as number;
  return data.slice(start, (f.offsets[n - 1] as number) + (f.lengths[n - 1] as number));
}

/** The 58-second stitching input: the start of doubleday-ch00-90s.mp3, short enough for one keyless OVH request. */
export function doubleday58(): Uint8Array {
  return firstSeconds(fixtureBytes('doubleday-ch00-90s.mp3'), 58);
}

export function fileRef(name: string) {
  return { input: name, platform: 'file', kind: 'video' as const, id: `file:${name}`, nativeId: name };
}
