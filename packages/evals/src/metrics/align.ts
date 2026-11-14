/**
 * Levenshtein alignment. `align` keeps a backtrace so callers can pair
 * reference tokens with hypothesis tokens (timing and punctuation metrics);
 * `editCounts` keeps only two rows plus running substitution, deletion and
 * insertion counts, so character-level scoring of long texts stays small.
 *
 * Both break ties the same way: match or substitution first, then deletion,
 * then insertion. Counts therefore agree between the two.
 */

export type EditOp = 'match' | 'sub' | 'del' | 'ins';

export interface AlignStep {
  op: EditOp;
  /** Index in the reference; absent for insertions. */
  ref?: number;
  /** Index in the hypothesis; absent for deletions. */
  hyp?: number;
}

export interface EditCounts {
  matches: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  refLength: number;
  hypLength: number;
}

export interface Alignment extends EditCounts {
  steps: AlignStep[];
}

const MATCH = 0;
const SUB = 1;
const DEL = 2;
const INS = 3;

type Eq<T> = (a: T, b: T) => boolean;
const strictEq = <T>(a: T, b: T): boolean => a === b;

/**
 * Align two token sequences with a full backtrace (one byte per cell). A six
 * minute video is about 1,000 words, so a word alignment needs about 1 MB.
 */
export function align<T>(ref: readonly T[], hyp: readonly T[], eq: Eq<T> = strictEq): Alignment {
  const n = ref.length;
  const m = hyp.length;
  const w = m + 1;
  const back = new Uint8Array((n + 1) * w);
  let prev = new Uint32Array(w);
  let cur = new Uint32Array(w);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    back[j] = INS;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    back[i * w] = DEL;
    const r = ref[i - 1] as T;
    for (let j = 1; j <= m; j++) {
      const same = eq(r, hyp[j - 1] as T);
      let best = (prev[j - 1] as number) + (same ? 0 : 1);
      let op = same ? MATCH : SUB;
      const del = (prev[j] as number) + 1;
      if (del < best) {
        best = del;
        op = DEL;
      }
      const ins = (cur[j - 1] as number) + 1;
      if (ins < best) {
        best = ins;
        op = INS;
      }
      cur[j] = best;
      back[i * w + j] = op;
    }
    [prev, cur] = [cur, prev];
  }

  const steps: AlignStep[] = [];
  const counts: EditCounts = { matches: 0, substitutions: 0, deletions: 0, insertions: 0, refLength: n, hypLength: m };
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const op = i === 0 ? INS : j === 0 ? DEL : (back[i * w + j] as number);
    if (op === MATCH || op === SUB) {
      i--;
      j--;
      steps.push({ op: op === MATCH ? 'match' : 'sub', ref: i, hyp: j });
      if (op === MATCH) counts.matches++;
      else counts.substitutions++;
    } else if (op === DEL) {
      i--;
      steps.push({ op: 'del', ref: i });
      counts.deletions++;
    } else {
      j--;
      steps.push({ op: 'ins', hyp: j });
      counts.insertions++;
    }
  }
  steps.reverse();
  return { steps, ...counts };
}

/**
 * Edit counts without a backtrace: O(m) memory. Each cell carries the
 * substitution, deletion and insertion counts of its best path.
 */
export function editCounts<T>(ref: readonly T[], hyp: readonly T[], eq: Eq<T> = strictEq): EditCounts {
  const n = ref.length;
  const m = hyp.length;
  const w = m + 1;
  let pd = new Uint32Array(w);
  let ps = new Uint32Array(w);
  let pdel = new Uint32Array(w);
  let pins = new Uint32Array(w);
  let cd = new Uint32Array(w);
  let cs = new Uint32Array(w);
  let cdel = new Uint32Array(w);
  let cins = new Uint32Array(w);
  for (let j = 0; j <= m; j++) {
    pd[j] = j;
    pins[j] = j;
  }
  for (let i = 1; i <= n; i++) {
    cd[0] = i;
    cs[0] = 0;
    cdel[0] = i;
    cins[0] = 0;
    const r = ref[i - 1] as T;
    for (let j = 1; j <= m; j++) {
      const same = eq(r, hyp[j - 1] as T);
      let best = (pd[j - 1] as number) + (same ? 0 : 1);
      let s = (ps[j - 1] as number) + (same ? 0 : 1);
      let d = pdel[j - 1] as number;
      let ins = pins[j - 1] as number;
      const del = (pd[j] as number) + 1;
      if (del < best) {
        best = del;
        s = ps[j] as number;
        d = (pdel[j] as number) + 1;
        ins = pins[j] as number;
      }
      const insC = (cd[j - 1] as number) + 1;
      if (insC < best) {
        best = insC;
        s = cs[j - 1] as number;
        d = cdel[j - 1] as number;
        ins = (cins[j - 1] as number) + 1;
      }
      cd[j] = best;
      cs[j] = s;
      cdel[j] = d;
      cins[j] = ins;
    }
    [pd, cd] = [cd, pd];
    [ps, cs] = [cs, ps];
    [pdel, cdel] = [cdel, pdel];
    [pins, cins] = [cins, pins];
  }
  const substitutions = ps[m] as number;
  const deletions = pdel[m] as number;
  const insertions = pins[m] as number;
  return { matches: n - substitutions - deletions, substitutions, deletions, insertions, refLength: n, hypLength: m };
}
