/**
 * Records a real VideoContext through the pipeline's speech-to-text path
 * when YouTube refuses caption requests from this IP (HTTP 429): metadata
 * from the YouTube provider, transcript from core `transcribe()` on the
 * speech-to-text chain (keyless OVH Whisper with no keys set).
 *
 *   npx tsx packages/insights/scripts/record-stt-context.ts <video id> <audio file (mp3)>
 *
 * The audio file is the video's own audio track, downloaded with the
 * managed yt-dlp (.vid2context/bin/yt-dlp -f bestaudio) and re-encoded to
 * 16 kHz mono MP3 with ffmpeg. Writes
 * packages/insights/test/fixtures/contexts/youtube-<id>.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createContext, Registry, stderrLogger, transcribe, type VideoContext } from '@vid2context/core';
import stt from '@vid2context/provider-stt-openai-compatible';
import youtube from '@vid2context/provider-youtube';

const [id, file] = process.argv.slice(2);
if (!id || !file) {
  console.error('usage: record-stt-context.ts <video id> <audio file>');
  process.exit(2);
}
const registry = new Registry([...youtube, ...(Array.isArray(stt) ? stt : [stt])], 'node');
const ctx = createContext({ runtime: 'node', env: {}, log: stderrLogger('info') });
const { source, ref } = registry.resolve(`https://www.youtube.com/watch?v=${id}`);
const started = Date.now();
const metadata = await source.getMetadata(ref, ctx);
const data = new Uint8Array(readFileSync(file));
const { transcript, attempts } = await transcribe(
  registry,
  ref,
  { kind: 'bytes', data, mimeType: 'audio/mpeg', filename: basename(file), durationSec: metadata.durationSec },
  { stt: { language: 'en' } },
  ctx,
);
const context: VideoContext = {
  metadata,
  transcript,
  attempts: [
    { id: source.id, stage: 'resolve', outcome: 'ok', detail: ref.id },
    { id: source.id, stage: 'metadata', outcome: 'ok', ms: Date.now() - started },
    { id: 'yt-dlp', stage: 'audio', outcome: 'ok', detail: 'bestaudio, re-encoded to 16 kHz mono MP3 with ffmpeg' },
    ...attempts,
  ],
};
const out = new URL(`../test/fixtures/contexts/youtube-${id}.json`, import.meta.url);
writeFileSync(out, `${JSON.stringify(context, null, 2)}\n`);
console.error(`${id}  ${metadata.title}  ${transcript.producer} ${transcript.segments.length} segments`);
