/**
 * Read a long video the way an agent should: look at the outline (sections
 * with token counts) first, then pull only the section you need, by chapter
 * or by time range.
 *
 *   npx tsx examples/library/outline-and-sections.ts
 *
 * Offline: reads a real 18-minute YouTube transcript (auto-captions, no
 * chapters, so the outline falls back to sections of about five minutes).
 */
import { readFileSync } from 'node:fs';
import {
  estimateTokens,
  formatTimestamp,
  getSection,
  parseTimeArg,
  render,
  transcriptOutline,
  type VideoContext,
} from '@vid2context/core';

const context: VideoContext = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8'),
);

const out = (s: string) => process.stdout.write(s);

// 1. The outline: cheap to read, tells you where everything is and what it costs.
const outline = transcriptOutline(context);
out(`${outline.title}\n${formatTimestamp(outline.durationSec)} long, about ${outline.totalTokens} tokens\n\n`);
for (const s of outline.sections) {
  out(
    `  #${s.index}  ${formatTimestamp(s.startSec).padStart(5)}  ${String(s.tokens).padStart(5)} tokens  ${s.title} (${s.source})\n`,
  );
}

// 2. One section by its outline index. The raw transcript is sliced, never rewritten.
const third = getSection(context, { chapter: 2 });
out(`\nSection #2: ${third.transcript.segments.length} segments, about ${estimateTokens(render(third, 'text'))} tokens\n`);
out(`${render(third, 'text', { timestamps: true }).split('\n').slice(0, 4).join('\n')}\n`);

// 3. A time range, with times written the way people type them.
const range = getSection(context, { fromSec: parseTimeArg('12:30'), toSec: parseTimeArg('13:00') });
out('\n12:30 to 13:00\n');
out(render(range, 'text', { timestamps: true }));
