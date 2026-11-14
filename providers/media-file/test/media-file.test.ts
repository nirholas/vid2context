import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { matchFile, mediaFile } from '../src/index.ts';

// Real public-domain NASA recording (tests/fixtures/media/README.md).
const APOLLO = resolve(join(import.meta.dirname, '../../../tests/fixtures/media/apollo11-small-step.mp3'));

describe('matchFile', () => {
  it('matches absolute paths and file URLs to the same stable id', () => {
    const a = matchFile(APOLLO);
    const b = matchFile(pathToFileURL(APOLLO).href);
    expect(a).toMatchObject({ platform: 'file', kind: 'video', url: pathToFileURL(APOLLO).href });
    expect(a?.id).toMatch(/^file:[0-9a-f]{32}$/);
    expect(b?.id).toBe(a?.id);
  });

  it('leaves YouTube ids, web URLs and extensionless missing names alone', () => {
    expect(matchFile('jNQXAC9IVRw')).toBeNull();
    expect(matchFile('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toBeNull();
    expect(matchFile('notes')).toBeNull();
  });

  it('matches a missing media path so the user gets a not-found error, not unsupported-input', async () => {
    const ref = matchFile('/nonexistent/interview.mp3');
    expect(ref?.platform).toBe('file');
    await expect(mediaFile.getMetadata(ref as NonNullable<typeof ref>, testContext())).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('mediaFile', () => {
  const ref = matchFile(APOLLO);
  if (!ref) throw new Error('fixture did not match');

  it('reads metadata from the filesystem', async () => {
    const meta = await mediaFile.getMetadata(ref, testContext());
    expect(meta).toMatchObject({ title: 'apollo11-small-step', chapters: [], extra: { path: APOLLO, sizeBytes: 145412 } });
  });

  it('supplies the bytes with a mime type from the extension', async () => {
    expect(mediaFile.canProvideAudio?.(ref, testContext())).toBe(true);
    const audio = await mediaFile.getAudio?.(ref, testContext());
    expect(audio).toMatchObject({ kind: 'bytes', mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' });
    expect(audio?.kind === 'bytes' && audio.data.byteLength).toBe(145412);
  });
});
