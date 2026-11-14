/**
 * Turn a video URL (or a local media file) into a VideoContext with the full
 * free-first pipeline: platform captions first, then speech-to-text through
 * the rung chain. Prints the transcript and every attempt that was made.
 *
 *   npx tsx examples/library/get-transcript.ts [url-or-file]
 *
 * Live, no keys needed. Keys in the environment or ./.env add more rungs.
 * Default input: "Me at the zoo", the first YouTube video.
 */
import { formatTimestamp, getVideoContext, render, Vid2ContextError } from '@vid2context/core';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';

loadEnvFiles();
const registry = createRegistry();
const ctx = createNodeContext();
const input = process.argv[2] ?? 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

try {
  const context = await getVideoContext(registry, input, { mode: 'auto', language: 'en' }, ctx);
  const { metadata, transcript } = context;
  process.stdout.write(`${metadata.title}\n`);
  process.stdout.write(`${metadata.channel?.name ?? 'unknown channel'}, ${formatTimestamp(metadata.durationSec ?? 0)}, `);
  process.stdout.write(`${transcript.origin} (${transcript.language}) from ${transcript.producer}\n\n`);
  process.stdout.write(render(context, 'text', { timestamps: true }));
  process.stdout.write('\nAttempts:\n');
  for (const a of context.attempts) process.stdout.write(`  ${a.stage.padEnd(8)} ${a.outcome.padEnd(7)} ${a.id}\n`);
} catch (err) {
  // User-facing errors carry a stable code and a hint on how to recover.
  if (err instanceof Vid2ContextError) console.error(`${err.code}: ${err.message}\nhint: ${err.hint ?? ''}`);
  else console.error(err);
  process.exitCode = 1;
}
