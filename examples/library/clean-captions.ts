/**
 * Turn unpunctuated auto-captions into readable sentences with the rule-based
 * cleanup (no model, no network), and read the report of what changed.
 *
 *   npx tsx examples/library/clean-captions.ts
 *
 * Offline: reads a real YouTube auto-caption transcript. The cleaned
 * transcript is a new object; the raw one is kept unchanged.
 */
import { readFileSync } from 'node:fs';
import { cleanTranscript, formatTimestamp, segmentsToText, type VideoContext } from '@vid2context/core';

const context: VideoContext = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8'),
);
const raw = context.transcript;
const out = (s: string) => process.stdout.write(s);

const { transcript: clean, report } = await cleanTranscript(raw, { sentences: true, fillers: true });

out(`Steps: ${report.steps.join(', ')}\n`);
out(`Segments: ${raw.segments.length} raw, ${clean.segments.length} clean `);
out(`(${report.merged} merged, ${report.removed} removed, ${report.rewritten} rewritten)\n`);

// Show the captions around the first sentence end the cleanup restored.
const at = Math.max(
  0,
  clean.segments.findIndex((s, i) => /[.?!]$/.test(s.text) && s.text !== raw.segments[i]?.text),
);
const window = (segments: typeof raw.segments) => segmentsToText(segments.slice(Math.max(0, at - 3), at + 4));
out(`\nRaw, around ${formatTimestamp(clean.segments[at]?.startSec ?? 0)}:\n${window(raw.segments)}\n`);
out(`\nClean:\n${window(clean.segments)}\n`);

out('\nFirst three changes:\n');
for (const ex of report.examples.slice(0, 3)) {
  out(`  [${formatTimestamp(ex.atSec)}] ${ex.rule}: "${ex.before}" -> "${ex.after}"\n`);
}
