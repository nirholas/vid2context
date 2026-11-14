/**
 * Render one transcript in every output format: plain text, timestamped
 * text, Markdown, SRT, WebVTT and the context pack written for AI models.
 *
 *   npx tsx examples/library/render-formats.ts
 *
 * Offline: reads a real VideoContext recorded from YouTube ("Me at the zoo").
 */
import { readFileSync } from 'node:fs';
import { formatters, render, type VideoContext } from '@vid2context/core';

const context: VideoContext = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contexts/youtube-jNQXAC9IVRw.json', import.meta.url), 'utf8'),
);

const out = (s: string) => process.stdout.write(s);

out(`Formats: ${Object.keys(formatters).join(', ')}\n\n`);

out('--- text\n');
out(render(context, 'text'));

out('\n--- text with timestamps\n');
out(render(context, 'text', { timestamps: true }));

out('\n--- srt (first two cues)\n');
out(`${render(context, 'srt').split('\n\n').slice(0, 2).join('\n\n')}\n`);

out('\n--- vtt (header, note and first cue)\n');
out(`${render(context, 'vtt').split('\n\n').slice(0, 3).join('\n\n')}\n`);

out('\n--- markdown\n');
out(render(context, 'markdown'));

out('\n--- pack (first 12 lines)\n');
out(`${render(context, 'pack', { maxTokens: 2000 }).split('\n').slice(0, 12).join('\n')}\n`);
