/**
 * Markdown report for one result file: a header with date, dataset size and
 * environment, one summary table per suite (rung, items, WER, CER, p50 and
 * p90 latency, cost, plus suite-specific columns), the per-item table, and
 * skipped rungs and notes.
 */
import { type EvalResult, type ItemResult, type RungSummary, summarize } from './results.ts';

const pct = (v: number | undefined): string => (v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const sec = (v: number | undefined): string => (v === undefined ? 'n/a' : `${v.toFixed(2)} s`);
const ms = (v: number | undefined): string => (v === undefined ? 'n/a' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const usd = (v: number | null | undefined): string => (v === undefined ? 'n/a' : v === null ? 'unpriced' : `$${v.toFixed(4)}`);
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join(
    '\n',
  );
}

function summaryTable(suite: EvalResult['suite'], rows: RungSummary[]): string {
  if (suite === 'captions' || suite === 'cleanup') {
    return table(
      ['Producer', 'Items', 'OK', 'WER', 'CER', 'S / D / I', 'Timing p50', 'Punct. F1', 'Caps F1'],
      rows.map((r) => [
        r.rung,
        String(r.items),
        String(r.ok),
        pct(r.wer),
        pct(r.cer),
        r.refWords === undefined ? 'n/a' : `${r.substitutions} / ${r.deletions} / ${r.insertions}`,
        sec(r.timingMedianSec),
        pct(r.punctuationF1),
        pct(r.capitalizationF1),
      ]),
    );
  }
  return table(
    ['Rung', 'Tier', 'Items', 'OK', 'WER', 'CER', 'S / D / I', 'p50 latency', 'p90 latency', 'RTF', 'Cost'],
    rows.map((r) => [
      r.rung,
      r.tier ?? 'n/a',
      String(r.items),
      String(r.ok),
      pct(r.wer),
      pct(r.cer),
      r.refWords === undefined ? 'n/a' : `${r.substitutions} / ${r.deletions} / ${r.insertions}`,
      ms(r.p50LatencyMs),
      ms(r.p90LatencyMs),
      r.realTimeFactor === undefined ? 'n/a' : r.realTimeFactor.toFixed(2),
      usd(r.costUsd),
    ]),
  );
}

function itemRow(i: ItemResult): string[] {
  return [
    i.item,
    i.language,
    i.rung,
    i.outcome === 'ok' ? 'ok' : `${i.outcome}${i.reason ? `: ${i.reason}` : ''}`,
    pct(i.wer?.rate),
    pct(i.cer?.rate),
    sec(i.timing?.medianSec),
    ms(i.latencyMs),
  ];
}

/** Render one result as Markdown. Deterministic for a given result. */
export function renderReport(result: EvalResult): string {
  const summary = summarize(result.items);
  const env = result.environment;
  const lines = [
    `# vid2context eval: ${result.suite} (${result.date})`,
    '',
    `- Dataset: \`${result.dataset.file}\`, ${result.dataset.evaluated} of ${result.dataset.items} items evaluated`,
    `- Rungs: ${env.rungs.length > 0 ? env.rungs.map((r) => `\`${r}\``).join(', ') : 'none'}`,
    `- Environment: Node ${env.node} on ${env.platform}, policy \`${env.policy}\`, keyless ${env.keyless ? 'on' : 'off'}`,
    `- Run: ${result.startedAt} to ${result.finishedAt}`,
    '',
    '## Summary',
    '',
    summary.length > 0 ? summaryTable(result.suite, summary) : 'No items were evaluated.',
    '',
    'WER and CER are pooled over items (total errors over total reference words or characters). S / D / I are substitutions, deletions and insertions. Timing p50 is the median word start-time difference against the reference. RTF is speech-to-text time over audio length.',
  ];
  if (result.items.length > 0) {
    lines.push(
      '',
      '## Items',
      '',
      table(
        ['Item', 'Lang', 'Rung', 'Outcome', 'WER', 'CER', 'Timing p50', 'Latency'],
        result.items.map(itemRow),
      ),
    );
  }
  if (result.skippedRungs.length > 0) {
    lines.push(
      '',
      '## Skipped rungs',
      '',
      ...result.skippedRungs.map((s) => `- \`${s.rung}\`: ${s.reason}${s.envVars?.length ? ` (set ${s.envVars.join(', ')})` : ''}`),
    );
  }
  if (result.notes.length > 0) lines.push('', '## Notes', '', ...result.notes.map((n) => `- ${n}`));
  return `${lines.join('\n')}\n`;
}
