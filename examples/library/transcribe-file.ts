/**
 * Transcribe a local audio or video file with speech-to-text. With no keys,
 * the keyless Whisper rung does the work; a local server (speaches,
 * whisper.cpp) or a free key (Groq, Gemini) runs first when configured.
 *
 *   npx tsx examples/library/transcribe-file.ts [file]
 *
 * Live, no keys needed. Sends the audio to the first enabled speech-to-text
 * rung. Default file: NASA's public-domain recording of Neil Armstrong's
 * first words on the Moon (24 seconds).
 */
import { fileURLToPath } from 'node:url';
import { attemptsOf, getVideoContext, render, Vid2ContextError } from '@vid2context/core';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';

loadEnvFiles();
const file = process.argv[2] ?? fileURLToPath(new URL('../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url));

try {
  const context = await getVideoContext(createRegistry(), file, { mode: 'stt', language: 'en' }, createNodeContext());
  process.stdout.write(render(context, 'text', { timestamps: true }));
  const stt = context.attempts.filter((a) => a.stage === 'stt');
  process.stdout.write(`\nTranscribed by ${context.transcript.producer} after ${stt.length} speech-to-text attempt(s):\n`);
  for (const a of stt) process.stdout.write(`  ${a.outcome.padEnd(7)} ${a.id}${a.reason ? ` (${a.reason})` : ''}\n`);
} catch (err) {
  if (!(err instanceof Vid2ContextError)) throw err;
  // Every rung failed: say why each one did, and how to recover.
  console.error(`${err.code}: ${err.message}\nhint: ${err.hint ?? ''}`);
  for (const a of attemptsOf(err))
    console.error(`  ${a.stage.padEnd(8)} ${a.outcome.padEnd(7)} ${a.id}${a.reason ? ` (${a.reason})` : ''}`);
  process.exitCode = 1;
}
