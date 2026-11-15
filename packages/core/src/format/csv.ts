/**
 * `csv`: one row per transcript segment, for spreadsheets and data tools.
 * Columns `start,end,speaker,text` (seconds with 3 decimals), plus
 * `secondary_text` when a secondary transcript is given. RFC 4180: CRLF line
 * ends, and fields holding a comma, a double quote or a line break are
 * quoted with inner quotes doubled.
 *
 * Caption text comes from third parties, so a text or speaker field that a
 * spreadsheet would run as a formula (starting with `=`, `+`, `@`, or `-`
 * followed by something other than a space) gets a leading apostrophe, as
 * OWASP recommends against CSV injection. A dialogue dash ("- Hi") is kept.
 */

import type { Formatter } from './index.ts';
import { cleanText } from './paragraphs.ts';
import { alignSecondary } from './secondary.ts';

/** One RFC 4180 field: quoted when it holds a comma, a double quote, CR or LF. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Neutralize text a spreadsheet would evaluate as a formula. */
export function csvSafeText(value: string): string {
  return /^(?:[=+@\t\r]|-(?! |$))/.test(value) ? `'${value}` : value;
}

export const csv: Formatter = {
  id: 'csv',
  description:
    'CSV (.csv) with one row per segment: start,end,speaker,text in seconds, plus secondary_text for bilingual output. For spreadsheets and data tools.',
  mimeType: 'text/csv; charset=utf-8',
  extension: 'csv',
  timed: 'always',
  bilingual: true,
  render(context, opts = {}) {
    const segs = context.transcript.segments.filter((s) => cleanText(s.text));
    const secondary = opts.secondary ? alignSecondary(segs, opts.secondary.segments) : undefined;
    const header = ['start', 'end', 'speaker', 'text', ...(secondary ? ['secondary_text'] : [])];
    const rows = segs.map((s, i) =>
      [
        s.startSec.toFixed(3),
        s.endSec.toFixed(3),
        csvSafeText(s.speaker ? cleanText(s.speaker) : ''),
        csvSafeText(cleanText(s.text)),
        ...(secondary ? [csvSafeText(secondary[i] ?? '')] : []),
      ]
        .map(csvField)
        .join(','),
    );
    return `${[header.join(','), ...rows].join('\r\n')}\r\n`;
  },
};
