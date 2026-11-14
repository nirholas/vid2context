/**
 * Token estimates for budgeting: context packs, chunking, fitting text into a
 * model's window. A fast heuristic, not a tokenizer: about 4 characters per
 * token for alphabetic scripts and about 1 token per CJK character. Use it
 * for budgets with headroom, never for billing.
 *
 * Created verbatim from docs/prompts/SHARED-CONTRACTS.md. Prompt 03 (chunking)
 * owns its accuracy and may improve the implementation, but must keep this
 * signature.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
