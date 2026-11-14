/**
 * Print timed visual notes for a video file or URL as JSON on stdout.
 *
 *   npx tsx providers/visual-frames/scripts/visual-notes.ts <file-or-url> [--max-frames 40] [--scene 0.3] [--min 2] [--max 30] [--policy free|local-only|quality]
 *
 * Uses every visual rung in the node registry, free first. Logs go to stderr
 * (VID2CONTEXT_LOG_LEVEL=info shows progress).
 */
import { parseArgs } from 'node:util';
import type { Policy } from '@vid2context/core';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';
import { extractVisualNotes } from '../src/node/index.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'max-frames': { type: 'string' },
    scene: { type: 'string' },
    min: { type: 'string' },
    max: { type: 'string' },
    policy: { type: 'string' },
  },
});
const input = positionals[0];
if (!input) {
  process.stderr.write(
    'usage: visual-notes.ts <file-or-url> [--max-frames N] [--scene 0.3] [--min 2] [--max 30] [--policy free|local-only|quality]\n',
  );
  process.exit(2);
}
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

loadEnvFiles();
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const ctx = createNodeContext({ signal: controller.signal });
try {
  const res = await extractVisualNotes(
    input,
    {
      maxFrames: num(values['max-frames']),
      sceneThreshold: num(values.scene),
      minIntervalSec: num(values.min),
      maxIntervalSec: num(values.max),
      chain: values.policy ? { policy: values.policy as Policy } : {},
      rungs: createRegistry().visualRungs(ctx.env),
    },
    ctx,
  );
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
} catch (err) {
  const e = err as { message?: string; hint?: string };
  process.stderr.write(`error: ${e.message ?? String(err)}\n`);
  if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
  process.exitCode = 1;
}
