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
  console.error(
    'usage: visual-notes.ts <file-or-url> [--max-frames N] [--scene 0.3] [--min 2] [--max 30] [--policy free|local-only|quality]',
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
  console.log(JSON.stringify(res, null, 2));
} catch (err) {
  const e = err as { message?: string; hint?: string };
  console.error(`error: ${e.message ?? String(err)}`);
  if (e.hint) console.error(`hint: ${e.hint}`);
  process.exitCode = 1;
}
