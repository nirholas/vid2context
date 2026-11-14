/** Loaders for the real transcripts the evals tests score. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Segment, VideoContext } from '@vid2context/core';
import type { RecordedRef } from '../src/refs.ts';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const shared = (name: string): string => fileURLToPath(new URL(`../../../tests/fixtures/contexts/${name}`, import.meta.url));

export function sharedContext(name: string): VideoContext {
  return JSON.parse(readFileSync(shared(name), 'utf8')) as VideoContext;
}

export function fixtureRef(name: string): RecordedRef {
  return JSON.parse(readFileSync(fixture(name), 'utf8')) as RecordedRef;
}

/** "Me at the zoo" creator captions (jNQXAC9IVRw, shared fixture). */
export const zooCreator = (): Segment[] => sharedContext('youtube-jNQXAC9IVRw.json').transcript.segments;
/** YouTube auto-captions of a reupload of the same 19 s of audio, without punctuation. */
export const zooAutoPlain = (): Segment[] => fixtureRef('youtube-9Pd5fi1DCb8.auto-captions.en.json').segments;
/** YouTube auto-captions of another reupload, with punctuation and capitals. */
export const zooAutoPunct = (): Segment[] => fixtureRef('youtube-g5RBHWskGtc.auto-captions.en.json').segments;
