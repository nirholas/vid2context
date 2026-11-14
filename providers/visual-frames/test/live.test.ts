import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearCooldowns, createContext, type VisualNote } from '@vid2context/core';
import { tryLocateFfmpeg } from '@vid2context/ffmpeg';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetThrottle, visualRungs } from '../src/index.ts';
import { extractVisualNotes } from '../src/node/index.ts';

// Live tests: LIVE=1 npx vitest run providers/visual-frames
// The end-to-end test needs ffmpeg; the OVH test sends one frame to the keyless endpoint.
const FIX = join(import.meta.dirname, 'fixtures');
const CLIP = join(FIX, 'new-editor-experiences-0-120.mp4');
const env = process.env as Record<string, string | undefined>;
const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function noteNear(notes: VisualNote[], fromSec: number, toSec: number, words: string[]): VisualNote | undefined {
  return notes.find((n) => n.atSec >= fromSec && n.atSec <= toSec && words.some((w) => plain(n.text).includes(w)));
}

beforeEach(() => {
  resetThrottle();
  clearCooldowns();
});

describe.skipIf(!process.env.LIVE)('visual frames, live', () => {
  it('finds every slide of the clip with local OCR, at the right times', async (t) => {
    const ctx = createContext({
      runtime: 'node',
      env: { PATH: env.PATH, FFMPEG_PATH: env.FFMPEG_PATH, FFPROBE_PATH: env.FFPROBE_PATH },
    });
    if (!(await tryLocateFfmpeg(ctx))) t.skip();
    const res = await extractVisualNotes(CLIP, { sceneThreshold: 0.1, chain: { policy: 'local-only' } }, ctx);
    expect(res.durationSec).toBe(120);
    expect(res.frames.every((f) => f.sentTo === 'visual/tesseract/eng')).toBe(true);
    // The title slide cuts in at 26.9 s, the chart at 36.3 s, the code screen at 79.4 s, the article at 107.4 s.
    expect(noteNear(res.notes, 26, 30, ['vyzkum'])).toBeDefined();
    expect(noteNear(res.notes, 35, 40, ['aktivni editor'])).toBeDefined();
    expect(noteNear(res.notes, 79, 83, ['vaclav', 'jmeno', 'titul'])).toBeDefined();
    expect(noteNear(res.notes, 106, 111, ['odstavec', 'vaclav', 'viclav'])).toBeDefined();
    const times = res.notes.map((n) => n.atSec);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('reads a slide with keyless OVH Qwen2.5-VL from an image data URL', async () => {
    const ctx = createContext({ runtime: 'node', env: {} });
    const rung = visualRungs({}).find((r) => r.service === 'ovh');
    if (!rung) throw new Error('no ovh rung');
    const data = new Uint8Array(readFileSync(join(FIX, 'frame-030s.jpg')));
    const notes = await rung.read({ data, mimeType: 'image/jpeg', atSec: 30 }, ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe('slide');
    expect(plain(notes[0]?.text ?? '')).toContain('jak muze vyzkum prispet');
  });
});
