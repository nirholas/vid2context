/**
 * One-off measurement of estimateTokens against real tokenizers, on real
 * transcripts. Run with `npx tsx packages/core/test/chunk/measure-tokens.ts`;
 * it rewrites token-accuracy.json next to this file. The tokenizers are
 * devDependencies of @vid2context/core and are never imported by runtime code.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encode as cl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { encode as o200k } from 'gpt-tokenizer/encoding/o200k_base';
import llama3 from 'llama3-tokenizer-js';
import { render } from '../../src/format/index.ts';
import { segmentsToText } from '../../src/segments.ts';
import { estimateTokens } from '../../src/tokens.ts';
import type { VideoContext } from '../../src/types.ts';
import { srtText } from './srt.ts';

const fixtures = new URL('./fixtures/', import.meta.url);
const contexts = new URL('../../../../tests/fixtures/contexts/', import.meta.url);
const loadContext = (f: string): VideoContext => JSON.parse(readFileSync(new URL(f, contexts), 'utf8'));

interface Row {
  sample: string;
  script: string;
  chars: number;
  estimate: number;
  o200k: number;
  cl100k: number;
  llama3: number;
  errorPct: { o200k: number; cl100k: number; llama3: number };
}

const pct = (est: number, real: number): number => Math.round(((est - real) / real) * 1000) / 10;

function measure(sample: string, script: string, text: string): Row {
  const estimate = estimateTokens(text);
  const o = o200k(text).length;
  const c = cl100k(text).length;
  const l = llama3.encode(text, { bos: false, eos: false }).length;
  return {
    sample,
    script,
    chars: text.length,
    estimate,
    o200k: o,
    cl100k: c,
    llama3: l,
    errorPct: { o200k: pct(estimate, o), cl100k: pct(estimate, c), llama3: pct(estimate, l) },
  };
}

const SCRIPT: Record<string, string> = {
  en: 'Latin (English)',
  es: 'Latin (accented)',
  fr: 'Latin (accented)',
  it: 'Latin (accented)',
  pt: 'Latin (accented)',
  ru: 'Cyrillic',
  fa: 'Arabic',
  hi: 'Devanagari',
  ja: 'Japanese (Han and kana)',
  'zh-hans': 'Chinese (Han)',
  'zh-hant': 'Chinese (Han)',
  ko: 'Korean (Hangul)',
};

const rows: Row[] = [];
const g = loadContext('youtube-cCPsdFdlshc.json');
const zoo = loadContext('youtube-jNQXAC9IVRw.json');
rows.push(measure('youtube-cCPsdFdlshc transcript', 'Latin (English)', segmentsToText(g.transcript.segments)));
rows.push(measure('youtube-cCPsdFdlshc text with timestamps', 'Latin (English)', render(g, 'text', { timestamps: true })));
rows.push(measure('youtube-cCPsdFdlshc description', 'Latin (English)', g.metadata.description ?? ''));
rows.push(measure('youtube-jNQXAC9IVRw transcript', 'Latin (English)', segmentsToText(zoo.transcript.segments)));
for (const f of readdirSync(fixtures)
  .filter((f) => f.endsWith('.srt'))
  .sort()) {
  const lang =
    f
      .replace(/\.srt$/, '')
      .split('.')
      .at(-1) ?? '';
  rows.push(measure(f.replace(/\.srt$/, ''), SCRIPT[lang] ?? lang, srtText(readFileSync(new URL(f, fixtures), 'utf8'))));
}

// Chunk-sized pieces: one-minute windows of the English transcript.
const windows: { o200k: number; llama3: number }[] = [];
const segs = g.transcript.segments;
for (let t = 0; t < (segs.at(-1)?.endSec ?? 0); t += 60) {
  const text = segmentsToText(segs.filter((s) => s.startSec >= t && s.startSec < t + 60));
  if (!text) continue;
  const r = measure('', '', text);
  windows.push({ o200k: r.errorPct.o200k, llama3: r.errorPct.llama3 });
}
const stats = (xs: number[]) => ({
  meanAbsPct: Math.round((xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length) * 10) / 10,
  maxAbsPct: Math.max(...xs.map(Math.abs)),
});

const report = {
  measuredAt: new Date().toISOString().slice(0, 10),
  tokenizers: {
    o200k: 'gpt-tokenizer 4.1.0, o200k_base (GPT-4o and later)',
    cl100k: 'gpt-tokenizer 4.1.0, cl100k_base (GPT-4, GPT-3.5)',
    llama3: 'llama3-tokenizer-js 1.2.0 (Llama 3 family)',
  },
  rows,
  englishOneMinuteWindows: {
    count: windows.length,
    o200k: stats(windows.map((w) => w.o200k)),
    llama3: stats(windows.map((w) => w.llama3)),
  },
};
writeFileSync(new URL('./token-accuracy.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
for (const r of rows)
  console.error(
    `${r.sample.padEnd(46)} ${String(r.estimate).padStart(5)} o200k ${String(r.o200k).padStart(5)} ${String(r.errorPct.o200k).padStart(6)}%  cl100k ${String(r.errorPct.cl100k).padStart(6)}%  llama3 ${String(r.errorPct.llama3).padStart(6)}%`,
  );
console.error('one-minute windows', JSON.stringify(report.englishOneMinuteWindows));
