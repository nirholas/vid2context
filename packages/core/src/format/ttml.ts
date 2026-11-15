/**
 * `ttml`: Timed Text Markup Language 1 in the IMSC 1 text profile style, for
 * broadcast, streaming packagers and players that read TTML or DFXP. One
 * `<p>` per cue with `begin`/`end` clock times, `<br/>` between lines, and
 * all text XML-escaped. Speakers are written as `Name: ` at each turn. With a
 * secondary transcript, its text follows the primary lines in a smaller
 * `secondary` style span carrying its own `xml:lang`.
 */

import { buildCues, cueOptions, cueTime } from './cues.ts';
import type { Formatter } from './index.ts';
import { cleanText, describeOrigin } from './paragraphs.ts';

/**
 * Escape text for XML element content and attribute values, and drop the
 * characters XML 1.0 forbids (C0 controls other than tab and line breaks,
 * lone surrogates, U+FFFE and U+FFFF).
 */
export function escapeXml(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing characters XML 1.0 forbids is the point.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

export const ttml: Formatter = {
  id: 'ttml',
  description: 'TTML / IMSC (.ttml) timed text XML for broadcast, streaming packagers and players that read TTML or DFXP.',
  mimeType: 'application/ttml+xml',
  extension: 'ttml',
  timed: 'always',
  bilingual: true,
  render(context, opts = {}) {
    const { metadata: m, transcript: t } = context;
    const sec = opts.secondary;
    const x = (s: string) => escapeXml(cleanText(s));
    const desc = [
      `Source: ${m.ref.url ?? m.ref.input}`,
      `Transcript: ${describeOrigin(t)}${t.translated ? ', machine-translated' : ''}`,
      ...(sec
        ? [`Second language (${sec.language}): ${describeOrigin(sec)}${sec.translated ? ', machine-translated' : ''}`]
        : []),
    ].join('. ');
    const secLang = sec ? ` xml:lang="${x(sec.language)}"` : '';
    const ps = buildCues(t.segments, true, cueOptions(opts)).map((c) => {
      const primary = c.lines.map(escapeXml).join('<br/>');
      const second = c.secondary?.length
        ? `<br/><span style="secondary"${secLang}>${c.secondary.map(escapeXml).join('<br/>')}</span>`
        : '';
      return `      <p begin="${cueTime(c.startMs, '.')}" end="${cueTime(c.endMs, '.')}">${primary}${second}</p>`;
    });
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ttp:timeBase="media" xml:lang="${x(t.language)}">`,
      '  <head>',
      '    <metadata>',
      `      <ttm:title>${x(m.title)}</ttm:title>`,
      `      <ttm:desc>${x(desc)}</ttm:desc>`,
      '    </metadata>',
      '    <styling>',
      '      <style xml:id="default" tts:fontFamily="proportionalSansSerif" tts:fontSize="100%" tts:lineHeight="125%" tts:color="#FFFFFF" tts:backgroundColor="#000000C0" tts:textAlign="center"/>',
      '      <style xml:id="secondary" tts:fontSize="80%" tts:color="#FFEE99"/>',
      '    </styling>',
      '    <layout>',
      '      <region xml:id="bottom" tts:origin="10% 70%" tts:extent="80% 25%" tts:displayAlign="after" tts:textAlign="center"/>',
      '    </layout>',
      '  </head>',
      '  <body region="bottom" style="default">',
      '    <div>',
      ...ps,
      '    </div>',
      '  </body>',
      '</tt>',
    ];
    return `${lines.join('\n')}\n`;
  },
};
