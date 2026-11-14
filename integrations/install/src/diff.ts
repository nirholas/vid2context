/**
 * A unified-style line diff for --dry-run. Config files are small, so a plain
 * LCS table is fast enough and keeps this dependency free.
 */
export function lineDiff(before: string, after: string, path: string): string {
  if (before === after) return '';
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as number[];
    const below = lcs[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const lines: string[] = [`--- ${before === '' ? '/dev/null' : path}`, `+++ ${path}`];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      lines.push(`+ ${b[j]}`);
      j++;
    } else {
      lines.push(`- ${a[i]}`);
      i++;
    }
  }
  return `${lines.join('\n')}\n`;
}
