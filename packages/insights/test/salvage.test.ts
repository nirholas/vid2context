import { describe, expect, it } from 'vitest';
import { parseJsonObject, salvageTruncatedJson } from '../src/index.ts';
import { loadRecording } from './recording.ts';

/**
 * The complete single-pass answer recorded in brief-single.json (Llama 3.3
 * 70B on OVH, finish_reason stop). Cutting it short reproduces what a rung
 * that hits its output limit returns: the same text, stopped mid-claim.
 */
function recordedAnswer(): string {
  const rec = loadRecording('brief-single');
  const ok = rec.exchanges.find((e) => e.status === 200 && e.body.includes('"finish_reason":"stop"'));
  if (!ok) throw new Error('brief-single.json has no complete answer');
  return (JSON.parse(ok.body) as { choices: { message: { content: string } }[] }).choices[0]?.message.content ?? '';
}

describe('salvageTruncatedJson', () => {
  it('returns null for a complete answer, which parseJsonObject already reads', () => {
    const text = recordedAnswer();
    expect(parseJsonObject(text)).not.toBeNull();
    expect(salvageTruncatedJson(text)).toBeNull();
  });

  it('keeps every claim the model finished when the answer stops mid-claim', () => {
    const text = recordedAnswer();
    const full = parseJsonObject(text) as { claims: { id: string }[] };
    const cutAt = text.indexOf('"id":"k3"') + 20; // inside claim k3
    const cut = text.slice(0, cutAt);
    expect(parseJsonObject(cut)).toBeNull();
    const got = salvageTruncatedJson(cut) as { claims: { id: string }[] };
    expect(got.claims.map((c) => c.id)).toEqual(['k1', 'k2']);
    expect(got.claims).toEqual(full.claims.slice(0, 2));
  });

  it('returns null when nothing complete was written', () => {
    expect(salvageTruncatedJson(recordedAnswer().slice(0, 30))).toBeNull();
    expect(salvageTruncatedJson('no json here')).toBeNull();
  });
});
