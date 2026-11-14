/**
 * Chapter boundary agreement: precision and recall of predicted chapter
 * starts against reference starts, within plus or minus `toleranceSec`.
 *
 * Matching is one-to-one: candidate pairs within tolerance are taken in
 * order of increasing distance, so one reference boundary can satisfy only
 * one prediction. Boundaries at or before `toleranceSec` are ignored on
 * both sides because every chapter list starts at 0 and that match carries
 * no information.
 */
import { prf } from './stats.ts';

export interface BoundaryAgreement {
  reference: number;
  predicted: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
  toleranceSec: number;
}

export function boundaryAgreement(
  referenceStarts: readonly number[],
  predictedStarts: readonly number[],
  toleranceSec = 15,
): BoundaryAgreement {
  const ref = referenceStarts.filter((s) => s > toleranceSec);
  const pred = predictedStarts.filter((s) => s > toleranceSec);
  const pairs: { r: number; p: number; d: number }[] = [];
  ref.forEach((rs, r) => {
    pred.forEach((ps, p) => {
      const d = Math.abs(rs - ps);
      if (d <= toleranceSec) pairs.push({ r, p, d });
    });
  });
  pairs.sort((a, b) => a.d - b.d);
  const usedR = new Set<number>();
  const usedP = new Set<number>();
  for (const pair of pairs) {
    if (usedR.has(pair.r) || usedP.has(pair.p)) continue;
    usedR.add(pair.r);
    usedP.add(pair.p);
  }
  const matched = usedR.size;
  return {
    reference: ref.length,
    predicted: pred.length,
    matched,
    ...prf(matched, pred.length - matched, ref.length - matched),
    toleranceSec,
  };
}
