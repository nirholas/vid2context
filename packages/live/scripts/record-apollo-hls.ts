/**
 * Re-record test/fixtures/apollo-hls/: package the public-domain Apollo 11
 * clip (tests/fixtures/media/apollo11-small-step.mp3) as a live HLS event
 * stream with ffmpeg's own HLS muxer, reading the input in real time (-re)
 * the way a live origin does, and keep every distinct state of the media
 * playlist as it grows, up to the final one with EXT-X-ENDLIST.
 *
 *   npx tsx packages/live/scripts/record-apollo-hls.ts
 *
 * Needs ffmpeg (FFMPEG_PATH, PATH or ~/.local/bin).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTools } from '@vid2context/ffmpeg';

const root = join(import.meta.dirname, '../../..');
const out = join(import.meta.dirname, '../test/fixtures/apollo-hls');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const ffmpeg = findTools(process.env).ffmpeg;
if (!ffmpeg) throw new Error('ffmpeg not found');

const child = spawn(
  ffmpeg,
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-re',
    '-i',
    join(root, 'tests/fixtures/media/apollo11-small-step.mp3'),
    '-c:a',
    'aac',
    '-b:a',
    '32k',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_playlist_type',
    'event',
    '-hls_flags',
    'program_date_time',
    '-hls_segment_filename',
    join(out, 'seg-%d.ts'),
    join(out, 'live.m3u8'),
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

const states: string[] = [];
const poll = setInterval(() => {
  try {
    const text = readFileSync(join(out, 'live.m3u8'), 'utf8');
    if (text.includes('#EXTINF') && states.at(-1) !== text) states.push(text);
  } catch {
    // Not written yet.
  }
}, 50);

await new Promise<void>((resolve, reject) => {
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
});
clearInterval(poll);
const final = readFileSync(join(out, 'live.m3u8'), 'utf8');
if (states.at(-1) !== final) states.push(final);
rmSync(join(out, 'live.m3u8'));

states.forEach((text, i) => {
  writeFileSync(join(out, `playlist-${i + 1}.m3u8`), text);
});
// Segment files keep their names in the playlists; on disk they get .mpegts so TypeScript tooling skips them.
for (const f of readdirSync(out).filter((n) => n.endsWith('.ts')))
  renameSync(join(out, f), join(out, f.replace(/\.ts$/, '.mpegts')));
console.error(`saved ${states.length} playlist states; final has ENDLIST: ${final.includes('#EXT-X-ENDLIST')}`);
